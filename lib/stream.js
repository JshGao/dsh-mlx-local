/**
 * dsh-mlx-local 的本地请求拦截器。
 *
 * 不注册任何 provider;监听 llm/stream,当请求路由是 llm-pi-ai 中指向
 * 127.0.0.1/localhost 的 openai-completions 自定义提供方时,接管该请求:
 *
 *   - 把 harness 消息序列化为 OpenAI chat/completions 请求;
 *   - 把 reasoningEffort 翻译成 mlx_lm.server 的 chat_template_kwargs;
 *   - 解析 mlx_lm.server 的 SSE 流,翻译成 harness 的 StreamChunk 协议。
 *
 * mlx_lm.server 会忽略请求体里的 model 字段(它始终使用 --model 加载的
 * 模型),并且 0.31.x 如果收到未知的 model id 甚至会尝试去 HuggingFace
 * 解析该仓库。因此这里不发送 model,而是由 MlxServer 保证"当前加载模型
 * == 用户选择的模型"。
 */
import {
	CallId,
	EMPTY_RESPONSE_CODE,
	LlmAdapter,
	LlmError,
	ReasoningEffortId,
	attributionHeaders,
	contentHasImage
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

/** DSH LLM provider 路由名。 */
export const MLX_PROVIDER = "mlx-local";
/** 本地模型的思考开关(与 mlx_lm.server 的 enable_thinking 对应)。 */
const THINKING_ON = ReasoningEffortId("on");
const THINKING_OFF = ReasoningEffortId("off");
/** 流式读取空闲超时内部错误码(与上游 dsh-llm-deepseek 同款语义)。 */
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** 没有模型条目时的上下文窗口兜底。 */
const DEFAULT_CONTEXT_WINDOW = 131072;
/** 没有模型条目时的单次输出上限兜底。 */
const DEFAULT_MAX_TOKENS = 4096;
/** 与 MlxServer 保持一致的轻量比较(本地路径忽略末尾斜杠)。 */
function sameRepo(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return left === right;
	const trim = (value) => value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
	return trim(left) === trim(right);
}

//#region 请求序列化
/** 拼接消息里的 text 块。 */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** 本地服务是纯文本通道,遇到图片内容必须显式报错而不是静默丢弃。 */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) {
		throw new LlmError("MLX 本地模型暂不支持图片内容", "UNSUPPORTED_CONTENT");
	}
}
/** 序列化一条 assistant 消息:文本 + 工具调用。 */
function serializeAssistant(message) {
	return {
		role: "assistant",
		content: flattenText(message.content),
		...(message.content.some((block) => block.type === "tool-call") ? {
			tool_calls: message.content.filter((block) => block.type === "tool-call").map((block) => ({
				id: block.id,
				type: "function",
				function: {
					name: block.name,
					arguments: block.arguments
				}
			}))
		} : {})
	};
}
/**
 * 把 harness 消息数组转换为 OpenAI chat/completions 消息数组。
 * tool-result 块展开为独立的 `{role: "tool"}` 消息;混合在 user 消息里的
 * 文本会先发送,再发送同一消息里的各工具结果。
 */
export function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		if (message.role === "user") {
			const text = flattenText(message.content);
			const results = message.content.filter((block) => block.type === "tool-result");
			if (text.length > 0 || results.length === 0) {
				wire.push({
					role: "user",
					content: text
				});
			}
			for (const result of results) {
				wire.push({
					role: "tool",
					tool_call_id: result.toolCallId,
					content: flattenText(result.content)
				});
			}
			continue;
		}
		// 声明合并后的未知消息角色:保留为文本,让服务端决定。
		wire.push({
			role: message.role,
			content: flattenText(message.content)
		});
	}
	return wire;
}
/** 组装 mlx_lm.server 请求体(总是流式,不发送 model 字段)。 */
function serializeRequest(options) {
	const messages = [];
	if (options.system !== void 0) {
		messages.push({
			role: "system",
			content: options.system
		});
	}
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const thinkingArgs = options.reasoningEffort === undefined ? null :
		options.reasoningEffort === "off" ? { enable_thinking: false } :
		{ enable_thinking: true };
	return {
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...(tools !== void 0 && tools.length > 0 ? { tools } : {}),
		...(thinkingArgs === null ? {} : { chat_template_kwargs: thinkingArgs }),
		...(options.temperature !== void 0 ? { temperature: options.temperature } : {}),
		...(options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }),
		...(options.stop !== void 0 ? { stop: options.stop } : {})
	};
}
//#endregion

//#region SSE 解析与翻译
/**
 * 解析 SSE 字节流,依次产出 `data:` 载荷;`[DONE]` 作为最后一个值。
 * 容忍任意分块、CRLF、`\r` 与 keepalive 注释。流在没有 `[DONE]` 时
 * 结束视为截断响应并抛 `STREAM_CLOSED`。
 */
export async function* parseSse(body, signal, onActivity) {
	const reader = body.getReader();
	let release = () => {};
	if (signal !== undefined) {
		const abort = () => {
			void reader.cancel();
		};
		signal.addEventListener("abort", abort, { once: true });
		release = () => signal.removeEventListener("abort", abort);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines = [];
	let sawDone = false;
	const dispatch = () => {
		if (dataLines.length === 0) return null;
		const payload = dataLines.join("\n");
		dataLines = [];
		return payload;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			onActivity?.();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let start = 0;
			for (let index = 0; index < buffer.length; index++) {
				if (buffer[index] !== "\n") continue;
				let line = buffer.slice(start, index);
				start = index + 1;
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line.length === 0) {
					const payload = dispatch();
					if (payload === null) continue;
					yield payload;
					if (payload === "[DONE]") {
						sawDone = true;
						return;
					}
					continue;
				}
				if (line.startsWith(":")) continue;
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^ /, ""));
				}
				// 其他字段( event: / id: / retry: )本地服务不会使用,忽略。
			}
			buffer = buffer.slice(start);
		}
		buffer += decoder.decode();
		// 流结束前可能还留着一个没有空行结尾的 data 行。
		if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
		if (buffer.length > 0) {
			for (const line of buffer.split("\n")) {
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^ /, ""));
				}
			}
		}
		const payload = dispatch();
		if (payload !== null) {
			yield payload;
			if (payload === "[DONE]") sawDone = true;
		}
		if (!sawDone) {
			throw new LlmError("SSE 流在 [DONE] 之前结束(响应被截断)", "STREAM_CLOSED");
		}
	} finally {
		release();
		reader.releaseLock();
	}
}
/** wire finish_reason → harness FinishReason。 */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/** wire usage → harness 的不相交 token 计数。 */
function mapUsage(usage) {
	const cached = usage.prompt_tokens_details?.cached_tokens;
	const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
	const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
	return {
		inputTokens: Math.max(0, prompt - (typeof cached === "number" ? cached : 0)),
		outputTokens: output,
		...(typeof cached === "number" ? { cacheReadTokens: cached } : {})
	};
}
/**
 * 把 mlx_lm.server 的 SSE 载荷翻译成 harness StreamChunk。
 * 块在 `[DONE]` 时统一收尾;usage 与 finish 之后不再产出任何 chunk。
 */
export async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	const open = (kind) => {
		const block = { index: nextIndex++, kind, text: "" };
		order.push(block);
		return block;
	};
	const close = (block) => {
		if (block.kind === "text") {
			return { type: "text", text: block.text };
		}
		if (block.kind === "reasoning") {
			return { type: "reasoning", text: block.text };
		}
		return {
			type: "tool-call",
			id: CallId(block.callId ?? `call-${block.index}`),
			name: block.name ?? "",
			arguments: block.text
		};
	};
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) {
				yield { type: "block-end", index: block.index, block: close(block) };
			}
			if (pendingUsage !== undefined) {
				yield { type: "usage", usage: pendingUsage };
			}
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "模型返回了没有内容的完成响应",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`无法解析 SSE 载荷: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta ?? {};
			const reasoning = delta.reasoning;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (reasoningBlock === undefined) {
					reasoningBlock = open("reasoning");
					yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
				}
				reasoningBlock.text += reasoning;
				yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
			}
			const content = delta.content;
			if (typeof content === "string" && content.length > 0) {
				if (textBlock === undefined) {
					textBlock = open("text");
					yield { type: "block-start", index: textBlock.index, blockType: "text" };
				}
				textBlock.text += content;
				yield { type: "text-delta", index: textBlock.index, text: content };
			}
			for (const call of delta.tool_calls ?? []) {
				const index = Number.isInteger(call.index) ? call.index : `tool-${toolBlocks.size}`;
				let block = toolBlocks.get(index);
				if (block === undefined) {
					block = open("tool-call");
					toolBlocks.set(index, block);
					yield { type: "block-start", index: block.index, blockType: "tool-call" };
				}
				if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;
				if (typeof call.function?.name === "string" && call.function.name.length > 0) {
					block.name = call.function.name;
				}
				const fragment = typeof call.function?.arguments === "string" ? call.function.arguments : "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...(block.name === undefined ? {} : { name: block.name }),
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage !== undefined) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE 载荷流在 [DONE] 之前结束", "STREAM_CLOSED");
}
//#endregion

//#region 适配器与注册
/** 非 2xx HTTP 响应 → 稳定的 LlmError code。 */
function httpErrorCode(status) {
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/** 读取服务端返回的 error.message(本地服务一般直接给可读错误)。 */
async function providerErrorMessage(response) {
	try {
		const parsed = await response.json();
		return typeof parsed?.error?.message === "string" ? parsed.error.message :
			typeof parsed?.error === "string" ? parsed.error : "";
	} catch {
		return "";
	}
}
/**
 * `mlx-local` 提供者适配器。传输层只负责请求与 SSE 翻译;
 * 模型切换、服务启停全部复用 MlxServer 的状态机。
 */
export class MlxLlmAdapter extends LlmAdapter {
	constructor({ config, server }) {
		super();
		this.config = config;
		this.server = server;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "MLX Local"
		};
	}
	listModels(provider) {
		return Promise.resolve(this.config().models.map((entry) => ({
			provider,
			id: entry.id,
			name: entry.name ?? entry.id,
			...(entry.description === undefined ? {} : { description: entry.description }),
			inputModalities: ["text"]
		})));
	}
	resolveModel(provider, model, _signal) {
		const entry = this.config().models.find((candidate) => candidate.id === model);
		const thinkMode = this.config().thinkMode;
		const reasoning = entry?.thinking === true ? {
			efforts: [
				{ id: THINKING_ON, name: "开启思考" },
				{ id: THINKING_OFF, name: "关闭思考" }
			],
			...(thinkMode === "on" ? { defaultEffort: THINKING_ON } :
				thinkMode === "off" ? { defaultEffort: THINKING_OFF } : {})
		} : undefined;
		return Promise.resolve({
			...(entry === undefined ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : {
				provider,
				id: entry.id,
				name: entry.name ?? entry.id,
				...(entry.description === undefined ? {} : { description: entry.description }),
				inputModalities: ["text"]
			}),
			context: {
				contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
			},
			defaultMaxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
			...(reasoning === undefined ? {} : { reasoning })
		});
	}
	/** 保证服务正在运行且加载了用户选择的模型。 */
	async ensureServer(model) {
		const config = this.config();
		const status = this.server.status();
		const matches = status.state === "running" && status.modelRepo !== null &&
			sameRepo(this.server.resolveModel(model).repo, status.modelRepo) &&
			status.port === config.port;
		if (matches) return status;
		if (!config.serveOnDemand) {
			if (status.state !== "running") {
				throw new LlmError(
					"本地 MLX 服务未运行;请先执行 mlx_start,或在设置中开启“按需启动/切换服务”",
					"SERVER_OFFLINE"
				);
			}
			throw new LlmError(
				`本地 MLX 服务当前加载的是 "${status.modelId ?? status.modelRepo}"` +
				`,与所选模型 "${model}" 不一致;请执行 mlx_switch_model,或在设置中开启“按需启动/切换服务”`,
				"SERVER_MODEL_MISMATCH"
			);
		}
		// start() 内部幂等:停止时启动、模型不同时先停后启、并发调用共享任务。
		const started = await this.server.start(model);
		if (started.state !== "running") {
			throw new LlmError(
				`本地 MLX 服务未就绪(state=${started.state})` +
				(started.recentLog.length > 0 ? `\n最近日志:\n${started.recentLog.join("\n")}` : ""),
				"SERVER_OFFLINE"
			);
		}
		return started;
	}
	async *stream(options) {
		const config = this.config();
		await this.ensureServer(options.model);
		const baseURL = this.server.baseURL();
		const body = serializeRequest(options);
		const consumer = new AbortController();
		const watchdog = idleWatchdog(
			options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]),
			config.streamIdleTimeoutMs,
			STREAM_IDLE_TIMEOUT_CODE
		);
		let response;
		try {
			response = await fetch(`${baseURL}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"accept": "text/event-stream",
					...attributionHeaders()
				},
				body: JSON.stringify(body),
				signal: watchdog.signal
			});
		} catch (error) {
			if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
				throw new LlmError(`MLX 本地模型请求空闲超时(${config.streamIdleTimeoutMs}ms)`, "TIMEOUT", { cause: error });
			}
			if (options.signal?.aborted) {
				throw new LlmError("MLX 本地模型请求被调用方中止", "ABORTED", { cause: error });
			}
			throw new LlmError(`无法连接本地 MLX 服务 ${baseURL}`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			const detail = await providerErrorMessage(response);
			throw new LlmError(
				detail.length > 0 ? detail : `MLX 本地服务返回 HTTP ${response.status}`,
				httpErrorCode(response.status),
				{ status: response.status }
			);
		}
		if (response.body === null) {
			throw new LlmError("MLX 本地服务返回了空响应体", "EMPTY_RESPONSE");
		}
		const iterator = translate(parseSse(response.body, watchdog.signal, () => watchdog.pulse()))[Symbol.asyncIterator]();
		let exhausted = false;
		try {
			while (true) {
				const result = await watchdog.next(iterator);
				if (result.done) {
					exhausted = true;
					return;
				}
				yield result.value;
			}
		} catch (error) {
			if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
				throw new LlmError(`MLX 本地模型流式输出空闲超时(${config.streamIdleTimeoutMs}ms)`, "TIMEOUT", { cause: error });
			}
			if (options.signal?.aborted) {
				throw new LlmError("MLX 本地模型请求被调用方中止", "ABORTED", { cause: error });
			}
			if (error instanceof LlmError) throw error;
			throw new LlmError(`MLX 本地模型流式请求失败: ${error?.message ?? error}`, "TRANSPORT", { cause: error });
		} finally {
			consumer.abort("MLX stream consumer stopped");
			if (!exhausted && iterator.return !== undefined) {
				try {
					await iterator.return();
				} catch {
					/* 传输层清理失败不影响主错误 */
				}
			}
			watchdog[Symbol.dispose]();
		}
	}
}
/** 读取 llm-pi-ai 中指向本地 MLX 服务的 openai-completions 路由。 */
function localProviderRoutes(settingsService, llmPiAiNs) {
	const routes = new Set();
	const service = typeof settingsService === "function" ? settingsService() : settingsService;
	if (service === null || service === undefined) return routes;
	let section;
	try {
		section = service.get(llmPiAiNs);
	} catch {
		return routes;
	}
	for (const [route, provider] of Object.entries(section?.providers ?? {})) {
		if (provider?.api !== "openai-completions") continue;
		const baseURL = typeof provider.baseURL === "string" ? provider.baseURL : "";
		if (baseURL.includes("127.0.0.1") || baseURL.includes("localhost")) routes.add(route);
	}
	return routes;
}
/**
 * 安装 llm/stream 拦截器:不注册任何新 provider,也不改动模型选择器;
 * 当请求走的是用户已有的本地 openai-completions 自定义提供方时,直接
 * 由本插件发给 mlx_lm.server,并正确翻译 reasoningEffort →
 * chat_template_kwargs(启用/关闭 Qwen3 思考)。其他 provider 原样 next()。
 */
export function installLocalLlmInterceptor(ctx, tools) {
	const { config, server, settingsService, llmPiAiNs } = tools;
	const adapter = new MlxLlmAdapter({
		config: () => ({
			...config(),
			// 适配器只依赖这两个字段;provider 功能已移除,这里补默认值。
			serveOnDemand: false,
			streamIdleTimeoutMs: 300_000
		}),
		server
	});
	ctx.on("llm/stream", (options, next) => {
		if (!localProviderRoutes(settingsService, llmPiAiNs).has(options.provider)) return next();
		return adapter.stream(options);
	}, { global: true });
}
//#endregion
