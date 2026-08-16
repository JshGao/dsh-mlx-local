import assert from "node:assert/strict";
import test from "node:test";
import { parseSse, serializeMessages, translate } from "../lib/stream.js";

function sseBody(text, chunks = []) {
	return new ReadableStream({
		start(controller) {
			if (chunks.length > 0) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			} else {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			}
		}
	});
}

test("serializeMessages: system/user/tool-result/assistant tool_calls", () => {
	const wire = serializeMessages([
		{ role: "system", content: [{ type: "text", text: "你是助手" }] },
		{
			role: "user",
			content: [
				{ type: "text", text: "查天气" },
				{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "晴" }] }
			]
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "好的" },
				{ type: "tool-call", id: "call-1", name: "get_weather", arguments: "{\"city\":\"北京\"}" }
			]
		}
	]);
	assert.deepEqual(wire, [
		{ role: "system", content: "你是助手" },
		{ role: "user", content: "查天气" },
		{ role: "tool", tool_call_id: "call-1", content: "晴" },
		{
			role: "assistant",
			content: "好的",
			tool_calls: [{
				id: "call-1",
				type: "function",
				function: { name: "get_weather", arguments: "{\"city\":\"北京\"}" }
			}]
		}
	]);
});

test("parseSse: comments, keepalive, CRLF and multi-byte split", async () => {
	const body = sseBody("", [": keepalive 1/1\r\n\r\ndata: {\"t\":\"你", "好\"}\r\n\r\ndata: [DONE]\r\n\r\n"]);
	const payloads = [];
	for await (const payload of parseSse(body)) payloads.push(payload);
	assert.deepEqual(payloads, ["{\"t\":\"你好\"}", "[DONE]"]);
});

test("parseSse: missing [DONE] throws STREAM_CLOSED", async () => {
	const body = sseBody("data: {\"a\":1}\n\n");
	await assert.rejects(async () => {
		for await (const _payload of parseSse(body)) void _payload;
	}, (error) => error.code === "STREAM_CLOSED");
});

test("translate: mlx_lm.server reasoning + text + usage stream", async () => {
	const chunks = [];
	for await (const chunk of translate([
		JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning: "想" }, finish_reason: null }] }),
		JSON.stringify({ choices: [{ delta: { content: "你好" }, finish_reason: null }] }),
		JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
		JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } } }),
		"[DONE]"
	])) chunks.push(chunk);
	assert.deepEqual(chunks, [
		{ type: "block-start", index: 0, blockType: "reasoning" },
		{ type: "reasoning-delta", index: 0, text: "想" },
		{ type: "block-start", index: 1, blockType: "text" },
		{ type: "text-delta", index: 1, text: "你好" },
		{ type: "block-end", index: 0, block: { type: "reasoning", text: "想" } },
		{ type: "block-end", index: 1, block: { type: "text", text: "你好" } },
		{ type: "usage", usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7 } },
		{ type: "finish", reason: { kind: "stop" } }
	]);
});

test("translate: mlx_lm.server complete tool-call delta", async () => {
	const chunks = [];
	for await (const chunk of translate([
		JSON.stringify({
			choices: [{
				delta: {
					tool_calls: [{
						index: 0,
						id: "tc-1",
						type: "function",
						function: { name: "get_weather", arguments: "{\"city\":\"北京\"}" }
					}]
				},
				finish_reason: "tool_calls"
			}]
		}),
		"[DONE]"
	])) chunks.push(chunk);
	assert.equal(chunks.at(-1).type, "finish");
	assert.equal(chunks.at(-1).reason.kind, "tool-calls");
	const ended = chunks.find((chunk) => chunk.type === "block-end");
	assert.deepEqual(ended.block, {
		type: "tool-call",
		id: "tc-1",
		name: "get_weather",
		arguments: "{\"city\":\"北京\"}"
	});
});

test("translate: empty stop response becomes EMPTY_RESPONSE error", async () => {
	const chunks = [];
	for await (const chunk of translate([JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }), "[DONE]"])) {
		chunks.push(chunk);
	}
	assert.equal(chunks.at(-1).type, "finish");
	assert.equal(chunks.at(-1).reason.kind, "error");
	assert.equal(chunks.at(-1).reason.failure.code, "EMPTY_RESPONSE");
});
