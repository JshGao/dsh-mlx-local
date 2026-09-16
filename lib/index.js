/**
 * dsh-mlx-local
 *
 * 在 Apple Silicon 上用 MLX 框架运行本地大模型的 DSH 插件:
 *  - 模型目录管理(增删模型、预下载权重、切换当前服务模型)
 *  - `mlx_lm.server` 子进程的启停与状态管理(自带 Python venv)
 *  - OpenAI 兼容 API 地址 + 自定义提供方接入说明
 *
 * 本插件**不注册任何工具、也不注册系统提示词段**:它只是"把本地模型跑起来"
 * 的基础设施,全部操作都由用户在设置页「MLX 模型」栏目里完成,不会给任何
 * 会话增加固定请求成本。模型侧的接入走 DSH 的自定义提供方 + 本插件的
 * llm/stream 拦截器(见 lib/stream.js)。
 *
 * 模块结构:
 *  1. 配置 Schema 与解析
 *  2. 日志环形缓冲
 *  3. Python 环境管理(探测/venv/mlx-lm 安装)
 *  4. 服务进程管理(启动/就绪轮询/停止/崩溃检测/残留回收)
 *  5. 设置卡片 HTTP API(/mlx/api)
 *  6. LLM provider 适配器(见 lib/stream.js)
 *  7. apply() 装配与生命周期
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import z from "@deepseek-ai/schemastery";
import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { installLocalLlmInterceptor } from "./stream.js";

//#region 1. 常量与配置
/** 设置命名空间(设置页 / 模型页显示为该段)。 */
const NS = "mlx-local";
/** 默认 venv 目录。 */
const DEFAULT_VENV_DIR = "~/.dsh/mlx/venv";
/** 默认日志目录。 */
const DEFAULT_LOG_DIR = "~/.dsh/mlx/logs";
/** 默认服务端口(与 mlx_lm.server 默认一致)。 */
const DEFAULT_PORT = 8080;
/** 服务启动(含首次下载)的最大等待时间。 */
const DEFAULT_START_TIMEOUT_MS = 600_000;
/**
 * 外部监督脚本:sh 进程作为 DSH 的 detached 子进程,负责启动 python 并
 * 监视 DSH 主进程 pid。即使 DSH 被 SIGKILL(dispose/exit 都来不及执行),
 * 监督脚本也会在发现父进程消失后 1 秒内结束 python,从根上避免孤儿。
 */
const MLX_SUPERVISOR_SCRIPT = [
	"parent=$1; py=$2; shift 2",
	"\"$py\" \"$@\" & child=$!",
	"echo MLX_SERVER_PID:$child",
	"trap 'kill -TERM \"$child\" 2>/dev/null; wait \"$child\" 2>/dev/null; exit 0' TERM INT",
	"while kill -0 \"$parent\" 2>/dev/null; do",
	"  if ! kill -0 \"$child\" 2>/dev/null; then wait \"$child\"; exit $?; fi",
	"  sleep 1",
	"done",
	"kill -TERM \"$child\" 2>/dev/null",
	"for _ in 1 2 3 4 5; do kill -0 \"$child\" 2>/dev/null || break; sleep 1; done",
	"kill -KILL \"$child\" 2>/dev/null",
	"wait \"$child\" 2>/dev/null",
	"exit 0"
].join("\n");
/** 停止服务的 SIGTERM 宽限期。 */
const STOP_GRACE_MS = 5_000;
/** 服务空闲时探测 /health 的间隔。 */
const HEALTH_PROBE_INTERVAL_MS = 2_000;
/** 未找到合适 Python 时的安装引导文案。 */
const PYTHON_GUIDANCE = [
	"未找到合适的 Python(需要 3.9–3.13,建议 3.10 及以上)。",
	"请先安装 Python,例如:",
	"  brew install python@3.12",
	"或从 https://www.python.org/downloads/ 下载安装,然后在「设置 → MLX 模型」中重新初始化环境。"
].join("\n");
/** 默认模型目录(4-bit 量化,适合 8GB+ 内存的 Apple Silicon)。 */
const DEFAULT_MODELS = [
	{
		id: "llama-3.2-3b",
		repo: "mlx-community/Llama-3.2-3B-Instruct-4bit",
		name: "Llama 3.2 3B (4bit)",
		description: "轻量通用指令模型,占用 ~2GB",
		contextWindow: 131072,
		maxTokens: 4096
	},
	{
		id: "qwen2.5-7b",
		repo: "mlx-community/Qwen2.5-7B-Instruct-4bit",
		name: "Qwen2.5 7B (4bit)",
		description: "中文能力强,占用 ~4.5GB",
		contextWindow: 131072,
		maxTokens: 4096
	},
	{
		id: "qwen3-8b",
		repo: "mlx-community/Qwen3-8B-4bit",
		name: "Qwen3 8B (4bit,工具调用)",
		description: "支持函数调用与思维链,适合作为智能体后端,占用 ~5GB",
		contextWindow: 131072,
		maxTokens: 4096,
		thinking: true
	}
];
/** 模型目录条目 Schema。 */
const modelEntrySchema = z.object({
	id: z.string().required(),
	repo: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	thinking: z.boolean()
});
/** 插件配置 Schema(loader 校验 + 设置页表单)。 */
const Config = z.object({
	pythonBin: z.string().default(""),
	venvDir: z.string().default(DEFAULT_VENV_DIR),
	host: z.string().default("127.0.0.1"),
	port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT),
	defaultModel: z.string().default(""),
	models: z.array(modelEntrySchema).default(DEFAULT_MODELS),
	serverArgs: z.array(z.string()).default([]),
	thinkMode: z.union(["auto", "on", "off"]).default("auto"),
	startTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_START_TIMEOUT_MS)
});
/** 展开 ~ 开头的路径。 */
function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}
/** 模型引用比较:本地路径忽略末尾斜杠差异(HF 仓库保持原样)。 */
function sameModelRepo(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return left === right;
	const a = expandHome(left);
	const b = expandHome(right);
	const trimTrailing = (value) => value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
	return trimTrailing(a) === trimTrailing(b);
}
/** 校验模型目录条目,失败抛错。 */
function validateModelEntry(entry) {
	if (typeof entry.id !== "string" || entry.id.length === 0) throw new Error("模型 id 不能为空");
	if (!/^[A-Za-z0-9._-]+$/.test(entry.id)) throw new Error(`模型 id "${entry.id}" 只能包含字母、数字、._-`);
	if (typeof entry.repo !== "string" || entry.repo.length === 0) throw new Error(`模型 "${entry.id}" 的 repo(仓库或本地路径)不能为空`);
	if (entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length === 0)) throw new Error(`模型 "${entry.id}" 的 name 不能为空字符串`);
	if (entry.contextWindow !== undefined && (!Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0)) throw new Error(`模型 "${entry.id}" 的 contextWindow 必须是正整数`);
	if (entry.maxTokens !== undefined && (!Number.isInteger(entry.maxTokens) || entry.maxTokens <= 0)) throw new Error(`模型 "${entry.id}" 的 maxTokens 必须是正整数`);
	if (entry.thinking !== undefined && typeof entry.thinking !== "boolean") throw new Error(`模型 "${entry.id}" 的 thinking 必须是布尔值`);
}
/** 根据 id/repo/name 推断模型是否支持 enable_thinking(Qwen3 系列默认支持)。 */
function inferModelThinking(entry) {
	const haystack = [entry.id, entry.repo, entry.name ?? ""].join(" ").toLowerCase();
	if (/qwen\s*3/.test(haystack)) return true;
	if (entry.id === "qwen3-8b") return true;
	return false;
}
/** 从原始配置(loader entry 或设置快照)解析出完整有效配置。 */
function resolveConfig(raw) {
	const models = (raw?.models ?? DEFAULT_MODELS).map((entry) => {
		validateModelEntry(entry);
		// thinking 未显式配置时:先按默认目录补齐,再按 Qwen3 名称推断;
		// 这样用户设置里旧的 mlx-community-Qwen3-8B-4bit 条目也能自动获得开关。
		const thinking = entry.thinking ??
			DEFAULT_MODELS.find((model) => model.id === entry.id)?.thinking ??
			inferModelThinking(entry);
		return {
			id: entry.id,
			repo: entry.repo,
			...(entry.name === undefined ? {} : { name: entry.name }),
			...(entry.description === undefined ? {} : { description: entry.description }),
			...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
			...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
			...(thinking ? { thinking: true } : {})
		};
	});
	const seen = new Set();
	for (const model of models) {
		if (seen.has(model.id)) throw new Error(`模型目录中存在重复 id "${model.id}"`);
		seen.add(model.id);
	}
	const startTimeoutMs = raw?.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0 || startTimeoutMs > MAX_TIMER_DELAY_MS) {
		throw new Error(`startTimeoutMs 必须是 (0, ${MAX_TIMER_DELAY_MS}] 内的数字`);
	}
	const port = raw?.port ?? DEFAULT_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port 必须是 1–65535 的整数");
	if (raw?.defaultModel !== undefined && raw.defaultModel !== "" && !seen.has(raw.defaultModel)) {
		throw new Error(`defaultModel "${raw.defaultModel}" 不在模型目录中`);
	}
	const host = raw?.host ?? "127.0.0.1";
	if (typeof host !== "string" || host.length === 0) throw new Error("host 必须是非空字符串");
	const serverArgs = raw?.serverArgs ?? [];
	if (!Array.isArray(serverArgs) || serverArgs.some((item) => typeof item !== "string")) {
		throw new Error("serverArgs 必须是字符串数组");
	}
	if (raw?.thinkMode !== undefined && raw.thinkMode !== "auto" && raw.thinkMode !== "on" && raw.thinkMode !== "off") {
		throw new Error("thinkMode 只能是 auto/on/off");
	}
	return {
		pythonBin: raw?.pythonBin ?? "",
		venvDir: expandHome(raw?.venvDir ?? DEFAULT_VENV_DIR),
		host,
		port,
		defaultModel: raw?.defaultModel ?? "",
		models,
		serverArgs,
		thinkMode: raw?.thinkMode === "on" || raw?.thinkMode === "off" ? raw.thinkMode : "auto",
		startTimeoutMs
	};
}
//#endregion

//#region 2. 日志环形缓冲
/** 定长环形缓冲,保留最近 N 行日志。 */
class LogRing {
	constructor(size) {
		this.size = size;
		this.lines = [];
	}
	push(line) {
		this.lines.push(line);
		if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
	}
	tail(n = this.size) {
		return this.lines.slice(-n);
	}
}
/** 把子进程输出按行拆成带时间戳的日志(UTF-8 跨 chunk 安全)。 */
function pipeOutput(stream, onLine) {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	stream.on("data", (chunk) => {
		pending += decoder.write(chunk);
		let index;
		while ((index = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, index).replace(/\r$/, "");
			pending = pending.slice(index + 1);
			if (line.length > 0) onLine(line);
		}
	});
	stream.on("end", () => {
		const tail = decoder.end();
		if (tail.length > 0) pending += tail;
		if (pending.length > 0) onLine(pending.replace(/\r$/, ""));
		pending = "";
	});
}
//#endregion

//#region 3. Python 环境管理
/** Python 版本探测结果。 */
function probePython(bin) {
	try {
		const result = spawnSync(bin, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {
			timeout: 15_000,
			encoding: "utf8"
		});
		if (result.status !== 0) return null;
		const match = /^(\d+)\.(\d+)\.(\d+)/.exec((result.stdout ?? "").trim());
		if (!match) return null;
		return { bin, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
	} catch {
		return null;
	}
}
/** 在 venv 中检查 mlx_lm 是否可导入。 */
function hasMlxLm(venvPython) {
	try {
		const result = spawnSync(venvPython, ["-c", "import importlib.util; print(importlib.util.find_spec('mlx_lm') is not None)"], {
			timeout: 15_000,
			encoding: "utf8"
		});
		return result.status === 0 && (result.stdout ?? "").trim() === "True";
	} catch {
		return false;
	}
}
/** 读取 venv 中 mlx-lm 的版本号。 */
function mlxLmVersion(venvPython) {
	try {
		const result = spawnSync(venvPython, ["-c", "import importlib.metadata; print(importlib.metadata.version('mlx-lm'))"], {
			timeout: 15_000,
			encoding: "utf8"
		});
		return result.status === 0 ? (result.stdout ?? "").trim() : null;
	} catch {
		return null;
	}
}
/** 在 venv 中执行一条 python 命令(非交互,返回 {status, stdout, stderr})。 */
function runVenv(venvPython, args, timeoutMs = 120_000) {
	try {
		const result = spawnSync(venvPython, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error) {
		return { status: -1, stdout: "", stderr: String(error?.message ?? error) };
	}
}
/**
 * Python 环境管理:插件始终运行在自有 venv 中;探测宿主机上版本合适的
 * Python(3.9–3.13,优先 3.10–3.12)创建 venv 并安装 mlx-lm。
 * 找不到合适 Python 时给出安装引导,绝不静默失败。
 */
class MlxEnvironment {
	constructor({ venvDir, pythonBin, log }) {
		this.venvDir = venvDir;
		this.pythonBin = pythonBin ?? "";
		this.log = log ?? (() => {});
	}
	get venvPython() {
		return join(this.venvDir, "bin", "python");
	}
	get venvPip() {
		return join(this.venvDir, "bin", "pip");
	}
	/** 只读状态:用于设置卡片展示,不触发安装。 */
	inspect() {
		const venvProbe = probePython(this.venvPython);
		return {
			venvDir: this.venvDir,
			venvExists: venvProbe !== null,
			venvPythonVersion: venvProbe === null ? null : `${venvProbe.major}.${venvProbe.minor}.${venvProbe.patch}`,
			mlxLmInstalled: venvProbe !== null && hasMlxLm(this.venvPython),
			mlxLmVersion: venvProbe !== null && hasMlxLm(this.venvPython) ? mlxLmVersion(this.venvPython) : null,
			basePython: this.findBasePython()
		};
	}
	/** 按优先级探测宿主机上的基础 Python。 */
	findBasePython() {
		const names = ["python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3"];
		const candidates = [];
		if (this.pythonBin.length > 0) candidates.push(this.pythonBin);
		for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), "/usr/bin"]) {
			for (const name of names) candidates.push(join(dir, name));
		}
		for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
			for (const name of names) candidates.push(join(dir, name));
		}
		candidates.push("/usr/bin/python3");
		const found = [];
		const seen = new Set();
		for (const candidate of candidates) {
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			const probe = probePython(candidate);
			if (probe !== null) found.push(probe);
		}
		if (found.length === 0) return null;
		const preferred = found.filter((p) => p.minor >= 10 && p.minor <= 12);
		const pool = preferred.length > 0 ? preferred : found.filter((p) => p.minor >= 9 && p.minor <= 13);
		if (pool.length === 0) return null;
		pool.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
		return pool[0];
	}
	/**
	 * 确保环境就绪:venv 存在且装有 mlx-lm → ready;否则选基础 Python 建
	 * venv、安装 mlx-lm。返回 {status, ...} 状态对象;失败时 detail/guidance
	 * 给出可执行下一步。
	 */
	async ensure() {
		const venvProbe = probePython(this.venvPython);
		if (venvProbe !== null && hasMlxLm(this.venvPython)) {
			return {
				status: "ready",
				venvDir: this.venvDir,
				venvPython: this.venvPython,
				pythonVersion: `${venvProbe.major}.${venvProbe.minor}.${venvProbe.patch}`,
				mlxLmVersion: mlxLmVersion(this.venvPython)
			};
		}
		const base = this.findBasePython();
		if (base === null) {
			return { status: "missing-python", guidance: PYTHON_GUIDANCE, detail: "未找到 3.9–3.13 的 Python" };
		}
		if (base.minor < 10) {
			this.log(`警告:使用 Python ${base.major}.${base.minor}.${base.patch}(${base.bin});建议安装 3.10+ 以获得更好的兼容性`);
		}
		if (venvProbe === null) {
			this.log(`创建虚拟环境: ${base.bin} -m venv ${this.venvDir}`);
			mkdirSync(dirname(this.venvDir), { recursive: true });
			const created = spawnSync(base.bin, ["-m", "venv", this.venvDir], { timeout: 180_000, encoding: "utf8" });
			if (created.status !== 0) {
				return {
					status: "error",
					detail: `创建虚拟环境失败:\n${(created.stderr ?? "").slice(0, 2000)}`,
					guidance: "可尝试换一个 venvDir,或安装更高版本 Python 后在设置页重新初始化环境"
				};
			}
		}
		const installed = await this.installMlxLm();
		return installed;
	}
	/** 在 venv 中安装/升级 mlx-lm,输出流式写入日志。 */
	installMlxLm() {
		return new Promise((resolvePromise) => {
			this.log("正在安装 mlx-lm(可能需要几分钟,首次会下载依赖)…");
			const child = spawn(this.venvPip, ["install", "--upgrade", "mlx-lm"], { stdio: ["ignore", "pipe", "pipe"] });
			let stderrTail = "";
			pipeOutput(child.stdout, (line) => this.log(line));
			pipeOutput(child.stderr, (line) => {
				stderrTail = (stderrTail + "\n" + line).slice(-2000);
				this.log(line);
			});
			child.once("error", (error) => {
				resolvePromise({
					status: "error",
					detail: `无法启动 pip: ${String(error?.message ?? error)}`,
					guidance: "请检查 venv 是否完整(可在设置页删除 venvDir 后重新初始化)"
				});
			});
			child.once("exit", (code) => {
				if (code !== 0) {
					resolvePromise({
						status: "error",
						detail: `pip install mlx-lm 失败(exit=${code}):\n${stderrTail.slice(0, 2000)}`,
						guidance: "网络问题可重试;若提示 Python 版本过新/过旧,请安装 3.10–3.12 的 Python 后在设置页重新初始化"
					});
					return;
				}
				if (!hasMlxLm(this.venvPython)) {
					resolvePromise({
						status: "error",
						detail: "mlx-lm 安装完成但无法导入,venv 可能不完整",
						guidance: "删除 venvDir 后在设置页重新初始化环境"
					});
					return;
				}
				const version = mlxLmVersion(this.venvPython);
				this.log(`mlx-lm 安装完成${version === null ? "" : `(版本 ${version})`}`);
				resolvePromise({
					status: "ready",
					venvDir: this.venvDir,
					venvPython: this.venvPython,
					pythonVersion: (() => {
						const probe = probePython(this.venvPython);
						return probe === null ? "?" : `${probe.major}.${probe.minor}.${probe.patch}`;
					})(),
					mlxLmVersion: version
				});
			});
		});
	}
}
//#endregion

//#region 4. 服务进程管理
/** 小工具:延迟。 */
function delay(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
/** 顺序无关的字符串数组比较(启动参数用)。 */
function stringArraysEqual(left, right) {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}
/** 探测本机 /health;返回是否可用。 */
async function probeHealth(host, port, timeoutMs = 1_500) {
	try {
		const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}
/** 用 lsof 查询端口上的监听进程 pid 列表。 */
function listenPidsOf(port) {
	try {
		const result = spawnSync("lsof", ["-nP", "-i", `:${port}`, "-sTCP:LISTEN", "-t"], {
			timeout: 10_000,
			encoding: "utf8"
		});
		return (result.stdout ?? "").trim().split("\n").filter((line) => line.length > 0).map((line) => Number(line));
	} catch {
		return [];
	}
}
/** 端口上监听进程中的 Python 进程 pid 列表(MLX 服务均为 python)。 */
function pythonListenPidsOf(port) {
	try {
		const result = spawnSync("lsof", ["-nP", "-i", `:${port}`, "-sTCP:LISTEN"], {
			timeout: 10_000,
			encoding: "utf8"
		});
		const pids = [];
		for (const line of (result.stdout ?? "").split("\n").slice(1)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length >= 2 && /python/i.test(parts[0])) pids.push(Number(parts[1]));
		}
		return pids;
	} catch {
		return [];
	}
}
/**
 * `mlx_lm.server` 子进程管理器:启动(含就绪轮询与后台状态提升)、停止、
 * 状态查询、崩溃检测、端口占用检测。
 */
class MlxServer {
	constructor({ env, config, log, ring }) {
		this.env = env;
		this.config = config;
		this.log = log ?? (() => {});
		this.ring = ring ?? new LogRing(200);
		this.logFile = null;
		this.state = "stopped";
		this.child = null;
		this.childDetached = false;
		this.pid = null;
		this.modelId = null;
		this.modelRepo = null;
		this.startedAt = null;
		this.exitInfo = null;
		this.host = null;
		this.port = null;
		this.activeServerArgs = [];
		this.activeThinkMode = "auto";
		this.portInUse = false;
		this.adopted = false;
		this.exitPromise = null;
		this.promoteTimer = null;
		this.startPromise = null;
		this.stopPromise = null;
		this.adoptPromise = null;
		this.lastAdoptAttempt = 0;
	}
	/**
	 * 收养外部运行中的 MLX 服务(孤儿进程接管):插件启动时调用。
	 * 端口上有响应 /health 且 /v1/models 可识别为 MLX 服务时,记录
	 * pid/模型并把状态机置为 running,之后可正常停止/切换。这样即使
	 * 上次 DSH 异常退出(dispose 未执行)留下了服务进程,新实例也能
	 * 识别并管理它,而不是变成无人认领的孤儿。
	 */
	async adopt() {
		if (this.adoptPromise !== null) return this.adoptPromise;
		this.adoptPromise = this.doAdopt().finally(() => {
			this.adoptPromise = null;
		});
		return this.adoptPromise;
	}
	async doAdopt() {
		if (this.state !== "stopped" || this.pid !== null) return false;
		const { host, port } = this.config();
		if (!(await probeHealth(host, port, 2_000))) {
			// /health 不通:区分"无服务"与"假死"(有进程监听但不响应)
			const pids = listenPidsOf(port);
			if (pids.length > 0) {
				this.portInUse = true;
				this.log(`端口 ${port} 有进程(pid ${pids.join(", ")})在监听但不响应 /health,疑似卡死或非 MLX 服务;可在设置页"回收残留服务"或手动处理`);
			}
			return false;
		}
		// 识别 MLX 服务:0.31.x 的 /v1/models 返回缓存中的模型列表(object=list),
		// 可用它确认身份,但无法得知"当前加载的模型",只能尽量匹配目录。
		let models = null;
		try {
			const response = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(3_000) });
			if (response.ok) {
				const parsed = await response.json();
				if (parsed?.object === "list" && Array.isArray(parsed.data)) models = parsed.data;
			}
		} catch {
			models = null;
		}
		if (models === null) {
			this.portInUse = true;
			this.log(`端口 ${port} 有服务响应 /health 但无法识别为 MLX 服务(/v1/models 不可用),标记为占用`);
			return false;
		}
		const pids = listenPidsOf(port);
		const pid = pids.length > 0 ? Number(pids[0]) : null;
		const entry = this.config().models.find((model) => models.some((item) => sameModelRepo(item.id, model.repo)));
		this.state = "running";
		this.adopted = true;
		this.pid = pid;
		this.modelId = entry?.id ?? null;
		this.modelRepo = entry?.repo ?? null;
		this.startedAt = Date.now();
		this.host = host;
		this.port = port;
		this.activeServerArgs = [];
		this.activeThinkMode = "auto";
		this.portInUse = false;
		this.log(`已接管外部运行中的 MLX 服务(pid=${pid ?? "?"}${entry === undefined ? ",模型未知(不在目录中)" : `,模型 ${entry.repo}`});切换模型会先停止该服务`);
		this.startPromoteTimer();
		return true;
	}
	/** 打开日志文件流(追加)。 */
	ensureLogFile() {
		if (this.logFile !== null) return;
		const logDir = expandHome("~/.dsh/mlx/logs");
		mkdirSync(logDir, { recursive: true });
		this.logFile = createWriteStream(join(logDir, "server.log"), { flags: "a" });
		this.logFile.on("error", () => {});
	}
	/** 一行服务日志:环形缓冲 + 文件(带时间戳)。 */
	logLine(line) {
		this.ensureLogFile();
		const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
		this.ring.push(`${stamp} ${line}`);
		this.logFile?.write(`${stamp} ${line}\n`);
	}
	/** 向自有服务进程(组)发送信号;进程组信号可覆盖服务派生的子进程。 */
	signalChild(signal) {
		const pid = this.child?.pid ?? this.pid;
		if (pid === null || pid === undefined) return;
		try {
			if (this.childDetached && this.child !== null) {
				process.kill(-pid, signal);
			} else {
				process.kill(pid, signal);
			}
		} catch {
			/* 进程可能已退出 */
		}
	}
	/**
	 * 同步清理(dispose/exit 兜底):先 SIGTERM 自有进程组,再清理本插件
	 * 端口上的 Python 残留。不做异步等待,适合进程退出前的最后一击。
	 */
	killNow(signal = "SIGTERM") {
		this.signalChild(signal);
		const port = this.port ?? this.config().port;
		for (const pid of pythonListenPidsOf(port)) {
			try {
				process.kill(pid, signal);
			} catch {
				/* 进程可能已退出 */
			}
		}
	}
	/** 插件卸载/停用时的同步清理:停掉监控定时器并终止服务进程组。 */
	disposeSync() {
		if (this.promoteTimer !== null) {
			clearInterval(this.promoteTimer);
			this.promoteTimer = null;
		}
		this.killNow("SIGTERM");
	}
	/** 解析模型引用:catalog id 或裸 repo/路径;无引用时用 defaultModel/目录首个。 */
	resolveModel(ref) {
		const config = this.config();
		const pack = (entry, id, repo) => ({ id, repo, thinking: entry?.thinking === true });
		if (ref !== undefined && ref !== null && ref !== "") {
			const entry = config.models.find((model) => model.id === ref);
			if (entry !== undefined) return pack(entry, entry.id, entry.repo);
			return pack(undefined, ref, ref);
		}
		if (config.defaultModel !== "") {
			const entry = config.models.find((model) => model.id === config.defaultModel);
			if (entry !== undefined) return pack(entry, entry.id, entry.repo);
		}
		if (config.models.length > 0) {
			const entry = config.models[0];
			return pack(entry, entry.id, entry.repo);
		}
		throw new Error("模型目录为空:请在「设置 → MLX 模型」中添加模型,或配置 defaultModel");
	}
	/** 等待状态机离开 starting/stopping。 */
	async settled(timeoutMs = 10_000) {
		const deadline = Date.now() + timeoutMs;
		while ((this.state === "starting" || this.state === "stopping") && Date.now() < deadline) {
			await delay(100);
		}
	}
	/**
	 * 启动服务。modelRef 缺省用 defaultModel/目录首个;启动前自动确保
	 * Python 环境;就绪采用 /health 轮询,长下载期间后台持续提升状态。
	 * 并发调用共享同一个进行中的启动任务。
	 */
	start(modelRef, overrides = {}) {
		if (this.startPromise !== null) return this.startPromise;
		this.startPromise = this.doStart(modelRef, overrides).finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}
	async doStart(modelRef, overrides = {}) {
		if (this.state === "stopping") await this.settled();
		if (this.adoptPromise !== null) await this.adoptPromise;
		const config = this.config();
		const host = overrides.host ?? config.host;
		const port = overrides.port ?? config.port;
		const serverArgs = overrides.serverArgs ?? config.serverArgs;
		const thinkMode = overrides.thinkMode ?? config.thinkMode;
		const target = this.resolveModel(modelRef);
		// 同模型、同端口、同参数且确实在运行 → 幂等返回。
		if (this.state === "running" && sameModelRepo(this.modelRepo, target.repo) &&
			this.host === host && this.port === port &&
			stringArraysEqual(this.activeServerArgs, serverArgs) &&
			this.activeThinkMode === thinkMode) {
			return this.status();
		}
		// 上一次 start 已超时但后台仍在下载:若目标是同一份配置,直接
		// 报告 starting;若目标/参数不同,先停掉旧进程再启动新进程。
		if (this.state === "starting" && sameModelRepo(this.modelRepo, target.repo) &&
			this.host === host && this.port === port &&
			stringArraysEqual(this.activeServerArgs, serverArgs) &&
			this.activeThinkMode === thinkMode) {
			return this.status();
		}
		if (this.state !== "stopped") await this.stop();
		const environment = await this.env.ensure();
		if (environment.status !== "ready") {
			throw new Error(
				`Python 环境未就绪:${environment.detail ?? environment.status}\n` +
				(environment.guidance ?? `请在「设置 → MLX 模型」中初始化 Python 环境`)
			);
		}
		if (await probeHealth(host, port)) {
			this.portInUse = true;
			throw new Error(`端口 ${port} 已被占用(已有服务在响应)。请停止占用方,或在设置中改用其他端口。`);
		}
		// 端口被残留(卡死/无响应)的 python 进程占用:先回收再启动,保证
		// 用户在异常残留存在时依然能正常启动服务。
		const stray = pythonListenPidsOf(port);
		if (stray.length > 0) {
			this.log(`端口 ${port} 被残留进程(pid ${stray.join(", ")})占用且无响应,先回收再启动`);
			for (const pid of stray) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					/* 进程可能已退出 */
				}
			}
			await delay(1_500);
			const left = pythonListenPidsOf(port);
			for (const pid of left) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* 进程可能已退出 */
				}
			}
			await delay(500);
			if (await probeHealth(host, port)) {
				this.portInUse = true;
				throw new Error(`端口 ${port} 的残留服务未能回收,请手动处理后再启动`);
			}
		}
		const args = [
			"-m", "mlx_lm.server",
			"--model", target.repo,
			"--host", host,
			"--port", String(port),
			...serverArgs
		];
		// 思考模式(仅对支持 enable_thinking 模板的模型如 Qwen3 生效):
		// on/off 强制开关;auto 按模型条目 thinking 字段决定,旧设置会自动推断 Qwen3。
		const enableThinking = thinkMode === "on" ? true :
			thinkMode === "off" ? false :
			target.thinking === true ? true : null;
		if (enableThinking !== null) {
			args.push("--chat-template-args", JSON.stringify({ enable_thinking: enableThinking }));
		}
		this.log(`启动服务: ${environment.venvPython} ${args.join(" ")}`);
		this.state = "starting";
		this.exitInfo = null;
		this.portInUse = false;
		let child;
		try {
			// 监督进程以独立进程组启动:即使 DSH 被强杀,sh 也会监视父 pid
			// 并在父进程消失后杀死 python;dispose/停止时 kill(-pid) 清整组。
			child = spawn("/bin/sh", ["-c", MLX_SUPERVISOR_SCRIPT, "dsh-mlx-supervisor", String(process.pid), environment.venvPython, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
				detached: true
			});
		} catch (error) {
			this.state = "stopped";
			throw new Error(`无法启动 MLX 服务进程: ${String(error?.message ?? error)}`);
		}
		this.child = child;
		this.childDetached = true;
		this.pid = child.pid ?? null;
		this.modelId = target.id;
		this.modelRepo = target.repo;
		this.startedAt = Date.now();
		this.host = host;
		this.port = port;
		this.activeServerArgs = [...serverArgs];
		this.activeThinkMode = thinkMode;
		let spawnError = null;
		this.exitPromise = new Promise((resolvePromise) => {
			child.once("exit", (code, signal) => resolvePromise({ code, signal, error: null }));
			child.once("error", (error) => {
				spawnError = String(error?.message ?? error);
				resolvePromise({ code: null, signal: null, error: spawnError });
			});
		});
		pipeOutput(child.stdout, (line) => {
			const match = /^MLX_SERVER_PID:(\d+)$/.exec(line);
			if (match !== null) {
				this.pid = Number(match[1]);
				return;
			}
			this.logLine(line);
		});
		pipeOutput(child.stderr, (line) => this.logLine(line));
		child.once("error", (error) => {
			this.log(`子进程错误: ${String(error?.message ?? error)}`);
		});
		this.exitPromise.then(({ code, signal, error }) => {
			this.child = null;
			this.childDetached = false;
			this.pid = null;
			this.exitInfo = { code, signal, error };
			if (this.state !== "stopping") {
				this.state = "stopped";
				this.log(error !== null ? `服务进程启动失败(${error})` : `服务进程退出(exit=${code}, signal=${signal})`);
			}
		});
		// 就绪轮询:每 500ms 探测一次,最长 startTimeoutMs;超时后由后台
		// 定时器继续提升状态(覆盖首次下载模型耗时较长的情况)。
		const deadline = Date.now() + config.startTimeoutMs;
		while (Date.now() < deadline) {
			const exited = await Promise.race([
				this.exitPromise.then((result) => ({ exited: true, ...result })),
				delay(500).then(() => null)
			]);
			if (exited !== null && exited.exited) {
				this.state = "stopped";
				const reason = exited.error === null ?
					`(exit=${exited.code}, signal=${exited.signal})` :
					`(${exited.error})`;
				throw new Error(
					`MLX 服务进程提前退出${reason}。` +
					`最近日志:\n${this.ring.tail(30).join("\n")}`
				);
			}
			if (await probeHealth(host, port)) {
				this.state = "running";
				this.startPromoteTimer();
				this.log(`服务就绪: http://${host}:${port} 模型 ${target.repo}`);
				return this.status();
			}
		}
		this.startPromoteTimer();
		throw new Error(
			`服务启动超过 ${Math.round(config.startTimeoutMs / 1000)} 秒仍未就绪` +
			`(首次运行可能正在下载模型权重,可在「设置 → MLX 模型」查看进度,服务就绪后状态会自动更新)。` +
			`最近日志:\n${this.ring.tail(15).join("\n")}`
		);
	}
	/** 后台状态提升:starting → running;stopped 且端口出现服务时重试接管;adopted 服务消失时回落 stopped。 */
	/** 后台状态提升与端口监控:每次探测都从当前配置读取 host/port,
	 * 端口设置变更后自动跟随新值(残留检测/接管/就绪提升均如此)。 */
	startPromoteTimer() {
		if (this.promoteTimer !== null) clearInterval(this.promoteTimer);
		this.promoteTimer = setInterval(() => {
			const { host, port } = this.config();
			void probeHealth(host, port).then((ok) => {
				if (!ok) {
					if (this.adopted) {
						this.state = "stopped";
						this.adopted = false;
						this.pid = null;
						this.modelId = null;
						this.modelRepo = null;
						this.log("被接管的外部服务已停止");
					}
					// 动态维护端口占用状态:残留进程消失即清除警告,
					// 持续存在(疑似卡死)才保持提示。
					const stray = pythonListenPidsOf(port);
					if (stray.length === 0) {
						if (this.portInUse) {
							this.portInUse = false;
							this.log(`端口 ${port} 的残留进程已消失,占用标记已清除`);
						}
					} else if (!this.portInUse) {
						this.portInUse = true;
						this.log(`端口 ${port} 有进程(pid ${stray.join(",")})在监听但不响应 /health,疑似卡死或非 MLX 服务;可重启 DSH 让其自动接管,或手动结束对应进程`);
					}
					return;
				}
				if (this.state === "starting") {
					this.state = "running";
					this.log("服务就绪(后台探测确认)");
				} else if (this.state === "stopped" && this.child === null && this.pid === null && !this.adopted) {
					// 端口出现健康服务:尝试接管(带 15s 冷却,避免反复探测)
					const now = Date.now();
					if (now - this.lastAdoptAttempt > 15_000) {
						this.lastAdoptAttempt = now;
						void this.adopt().then((ok) => {
							if (!ok) this.portInUse = true;
						});
					} else {
						this.portInUse = true;
					}
				}
			});
		}, HEALTH_PROBE_INTERVAL_MS);
		this.promoteTimer.unref?.();
	}
	/** 停止服务(并发安全):自有子进程 SIGTERM → 5s → SIGKILL;接管进程按端口探测停止。 */
	stop() {
		if (this.stopPromise !== null) return this.stopPromise;
		this.stopPromise = this.doStop().finally(() => {
			this.stopPromise = null;
		});
		return this.stopPromise;
	}
	async doStop() {
		if (this.state === "stopped") return this.status();
		if (this.state === "stopping") {
			await this.settled();
			return this.status();
		}
		if (this.promoteTimer !== null) {
			clearInterval(this.promoteTimer);
			this.promoteTimer = null;
		}
		const child = this.child;
		const adopted = this.adopted;
		const pid = this.pid;
		this.state = "stopping";
		this.log("正在停止服务…");
		if (child !== null && this.exitPromise !== null) {
			this.signalChild("SIGTERM");
			const exited = await Promise.race([this.exitPromise, delay(STOP_GRACE_MS).then(() => null)]);
			if (exited === null && child.exitCode === null) {
				this.log("SIGTERM 超时,发送 SIGKILL");
				this.signalChild("SIGKILL");
				await Promise.race([this.exitPromise, delay(2_000)]);
			}
		} else if (adopted && pid !== null) {
			// 接管的外部进程:按 pid 优雅停止,按端口确认释放
			const { host, port } = this.config();
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* 进程可能已退出 */
			}
			for (let i = 0; i < Math.ceil(STOP_GRACE_MS / 500); i++) {
				await delay(500);
				if (!(await probeHealth(host, port))) break;
			}
			if (await probeHealth(host, port)) {
				this.log("SIGTERM 超时,发送 SIGKILL");
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* 进程可能已退出 */
				}
				await delay(1_000);
			}
		}
		this.state = "stopped";
		this.child = null;
		this.childDetached = false;
		this.pid = null;
		this.modelId = null;
		this.modelRepo = null;
		this.startedAt = null;
		this.host = null;
		this.port = null;
		this.activeServerArgs = [];
		this.activeThinkMode = "auto";
		this.adopted = false;
		this.exitInfo = null;
		this.log("服务已停止");
		return this.status();
	}
	/** 切换模型:stop + start(mlx_lm.server 单进程单模型)。 */
	switchModel(modelRef) {
		return this.start(modelRef);
	}
	/** 服务是否处于 running 状态。 */
	isRunning() {
		return this.state === "running";
	}
	/** 服务实际监听的 OpenAI 兼容 API baseURL。 */
	baseURL() {
		const config = this.config();
		return `http://${this.host ?? config.host}:${this.port ?? config.port}/v1`;
	}
	/** 回收端口上的残留 Python 进程(仅 stopped 状态可执行)。 */
	async recoverPort() {
		if (this.state !== "stopped") {
			throw new Error("服务正在运行/启动中,无需回收;请先停止服务");
		}
		const { port } = this.config();
		const pids = pythonListenPidsOf(port);
		if (pids.length === 0) {
			this.portInUse = false;
			this.log(`端口 ${port} 没有残留进程,占用标记已清除`);
			return { recovered: [], port };
		}
		this.log(`回收端口 ${port} 上的残留进程(pid ${pids.join(", ")})`);
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* 进程可能已退出 */
			}
		}
		await delay(1_500);
		const left = pythonListenPidsOf(port);
		for (const pid of left) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 进程可能已退出 */
			}
		}
		await delay(500);
		const remaining = pythonListenPidsOf(port);
		this.portInUse = remaining.length > 0;
		if (remaining.length > 0) this.log(`端口 ${port} 仍有进程(pid ${remaining.join(", ")})未回收`);
		return { recovered: pids, remaining, port };
	}
	/** 当前状态快照(只读)。 */
	status() {
		const config = this.config();
		return {
			state: this.state,
			pid: this.pid,
			host: this.host ?? config.host,
			port: this.port ?? config.port,
			modelId: this.modelId,
			modelRepo: this.modelRepo,
			startedAt: this.startedAt,
			uptimeSec: this.startedAt === null ? null : Math.round((Date.now() - this.startedAt) / 1000),
			exitInfo: this.exitInfo,
			portInUse: this.portInUse,
			adopted: this.adopted,
			recentLog: this.ring.tail(30)
		};
	}
}
//#endregion

//#region 8b. 设置卡片 HTTP API(/mlx/api)
/** 校验 setConfig patch 的键与值,返回仅含合法键的 patch。 */
function validateConfigPatch(patch, config) {
	const allowed = new Set(["host", "port", "defaultModel", "serverArgs", "thinkMode", "models"]);
	// defaultModel 校验必须看到同一次 patch 中即将写入的新模型目录。
	const effectiveModels = Array.isArray(patch?.models) ? patch.models : config.models;
	const out = {};
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (!allowed.has(key)) throw new Error(`不支持的设置项 "${key}"`);
		switch (key) {
			case "host":
				if (typeof value !== "string" || value.length === 0) throw new Error("host 必须是非空字符串");
				out.host = value;
				break;
			case "port":
				if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("port 必须是 1–65535 的整数");
				out.port = value;
				break;
			case "defaultModel":
				if (value !== "" && !effectiveModels.some((model) => model.id === value)) {
					throw new Error(`defaultModel "${value}" 不在模型目录中`);
				}
				out.defaultModel = value;
				break;
			case "serverArgs":
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("serverArgs 必须是字符串数组");
				out.serverArgs = value;
				break;
			case "thinkMode":
				if (value !== "auto" && value !== "on" && value !== "off") throw new Error("thinkMode 只能是 auto/on/off");
				out.thinkMode = value;
				break;
			case "models": {
				if (!Array.isArray(value)) throw new Error("models 必须是数组");
				const seen = new Set();
				for (const entry of value) {
					validateModelEntry(entry);
					if (seen.has(entry.id)) throw new Error(`模型目录中存在重复 id "${entry.id}"`);
					seen.add(entry.id);
				}
				out.models = value;
				break;
			}
		}
	}
	return out;
}
/**
 * 判断模型条目的权重是否可用:本地路径检查目录内容;HF 仓库检查
 * HuggingFace 缓存目录。
 */
function modelWeightsAvailable(entry) {
	const repo = entry.repo;
	const isLocal = repo.startsWith("/") || repo.startsWith("~") || repo.startsWith("./") || repo.startsWith("../");
	try {
		if (isLocal) {
			const dir = expandHome(repo);
			return existsSync(join(dir, "config.json")) &&
				(existsSync(join(dir, "model.safetensors")) || existsSync(join(dir, "model.safetensors.index.json")));
		}
		const cacheDir = join(homedir(), ".cache", "huggingface", "hub", `models--${repo.replaceAll("/", "--")}`);
		return existsSync(cacheDir);
	} catch {
		return false;
	}
}
/** 判断一个目录是否为 MLX 模型目录(config.json + 权重文件)。 */
function isMlxModelDir(dir) {
	try {
		return existsSync(join(dir, "config.json")) &&
			(existsSync(join(dir, "model.safetensors")) || existsSync(join(dir, "model.safetensors.index.json")));
	} catch {
		return false;
	}
}
/**
 * 模型的规范化标识:用于识别"同一模型"的重复条目。
 * 本地路径取目录名、HF 仓库取 name 段;去掉常见的 org 前缀
 * (首个 "-"/"/" 之前的部分),如 mlx-community-Qwen3-8B-4bit、
 * mlx-community/Qwen3-8B-4bit、Qwen3-8B-4bit 归一为 qwen3-8b-4bit。
 */
function modelKey(entry) {
	const repo = entry.repo;
	const raw = repo.startsWith("/") || repo.startsWith("~") || repo.startsWith(".") ?
		repo.split("/").filter(Boolean).pop() ?? repo : repo;
	const name = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
	const trimmed = name.includes("-") ? name.slice(name.indexOf("-") + 1) : name;
	return trimmed.toLowerCase();
}
/**
 * 去重:同一模型(规范化标识相同)只保留一个条目——权重可用者优先,
 * 都可用时保留 id 较短的(通常是用户原有 id),并优先使用本地路径;
 * 正在服务的条目不会被丢弃。返回 {models, removed};不修改任何状态。
 */
function dedupeModels(currentModels, servingModelId) {
	const groups = new Map();
	const order = [];
	const removed = [];
	for (const model of currentModels) {
		const key = modelKey(model);
		const exist = groups.get(key);
		if (exist === undefined) {
			groups.set(key, model);
			order.push(key);
			continue;
		}
		const aOk = modelWeightsAvailable(exist);
		const bOk = modelWeightsAvailable(model);
		const aLocal = exist.repo.startsWith("/") || exist.repo.startsWith("~");
		const bLocal = model.repo.startsWith("/") || model.repo.startsWith("~");
		const prefer = (bOk && !aOk) || (aOk === bOk && bLocal && !aLocal) ||
			(aOk === bOk && bLocal === aLocal && model.id.length < exist.id.length) ? model : exist;
		const dropped = prefer === model ? exist : model;
		if (dropped.id === servingModelId) {
			// 正在服务的条目不丢弃:合并到它,repo 取权重可用的
			groups.set(key, { ...prefer, id: dropped.id, repo: prefer.repo, name: prefer.name ?? dropped.name });
			removed.push({ id: prefer.id, repo: prefer.repo, reason: "merged-into-serving" });
		} else {
			groups.set(key, prefer);
			removed.push({ id: dropped.id, repo: dropped.repo, reason: "duplicate-of-" + prefer.id });
		}
	}
	return { models: order.map((key) => groups.get(key)), removed };
}
/**
 * 清理:移除权重文件不可用的模型条目(正在服务的保留)。
 * 返回 {models, removed};不修改任何状态,由调用方持久化。
 */
function pruneMissingModels(currentModels, servingModelId) {
	const removed = [];
	const kept = [];
	for (const model of currentModels) {
		if (model.id !== servingModelId && !modelWeightsAvailable(model)) {
			removed.push({ id: model.id, repo: model.repo });
		} else {
			kept.push(model);
		}
	}
	return { models: kept, removed };
}
/** 设置摘要(卡片展示用)。 */
function configSummary(config) {
	return {
		host: config.host,
		port: config.port,
		defaultModel: config.defaultModel,
		serverArgs: config.serverArgs,
		thinkMode: config.thinkMode,
		models: config.models.map((model) => ({
			id: model.id,
			repo: model.repo,
			name: model.name ?? model.id,
			...(model.description === undefined ? {} : { description: model.description }),
			...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
			...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
			weightAvailable: modelWeightsAvailable(model)
		}))
	};
}
/** 同源 fence:Host 必须回环,且浏览器跨站请求被拒。 */
function isLoopbackHostHeader(hostHeader) {
	if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
	let hostname;
	try {
		hostname = new URL(`http://${hostHeader}`).hostname;
	} catch {
		return false;
	}
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
function mlxApiFence(req) {
	if (!isLoopbackHostHeader(req.headers.host)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}
function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function readJsonBody(req) {
	return new Promise((resolvePromise, rejectPromise) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			if (chunks.length === 0) {
				resolvePromise({});
				return;
			}
			try {
				resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				rejectPromise(new Error(`请求体不是合法 JSON: ${error?.message ?? error}`));
			}
		});
		req.on("error", rejectPromise);
	});
}
/**
 * 挂载 /mlx/api 设置卡片 API(webServer 服务可用时):
 * status / listModels / start / stop / switchModel / setConfig。
 * 仅本机回环同源可访问。
 */
function registerMlxApi(ctx, tools) {
	const { server, env, config, getSettingsUpdate } = tools;
	const respond = async (req, res) => {
		if (!mlxApiFence(req)) {
			writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
			return;
		}
		// webserver 只传 (req, res),路径从 req.url 解析
		const rawPath = new URL(req.url ?? "/", "http://x").pathname;
		const method = rawPath.startsWith("/mlx/api/") ? rawPath.slice("/mlx/api/".length) : "";
		let payload = {};
		try {
			payload = await readJsonBody(req);
		} catch (error) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: error?.message ?? String(error) } });
			return;
		}
		try {
			let value;
			switch (method) {
				case "status":
					value = {
						server: server.status(),
						environment: env.inspect(),
						config: configSummary(config())
					};
					break;
				case "listModels":
					value = { activeModelId: server.status().modelId, models: config().models };
					break;
				case "start": {
					// 启动不等就绪:2 秒内快速失败(环境缺失/端口占用/进程立即
					// 退出)会抛错;否则立即返回 starting 状态,就绪由后台探测
					// 推进,卡片轮询自行刷新,避免长阻塞卡住界面。
					const promise = server.start(payload.model, {
						port: typeof payload.port === "number" ? payload.port : undefined
					});
					value = await Promise.race([promise, delay(2_000).then(() => server.status())]);
					promise.catch(() => {});
					break;
				}
				case "stop":
					value = await server.stop();
					break;
				case "recover":
					value = await server.recoverPort();
					break;
				case "switchModel": {
					if (typeof payload.model !== "string" || payload.model.length === 0) throw new Error("缺少 model 参数");
					const promise = server.switchModel(payload.model);
					value = await Promise.race([promise, delay(2_000).then(() => server.status())]);
					promise.catch(() => {});
					break;
				}
				case "setConfig": {
					const update = getSettingsUpdate();
					if (update === null) throw new Error("设置服务不可用,无法保存参数");
					const patch = validateConfigPatch(payload.patch, config());
					if (Object.keys(patch).length === 0) throw new Error("没有可保存的变更");
					await update(patch);
					value = { saved: patch, config: configSummary(config()) };
					break;
				}
				case "load": {
					// 加载用户选择的本地模型目录:验证 → 去重合并 → 加入列表。
					// 只入目录,不启动服务;启动由用户显式触发。
					const path = typeof payload.path === "string" ? payload.path : "";
					if (path.length === 0) throw new Error("缺少 path 参数");
					const dir = expandHome(path);
					if (!isMlxModelDir(dir)) {
						throw new Error(`所选目录不是 MLX 模型目录(缺少 config.json 或 model.safetensors): ${dir}`);
					}
					const name = dir.split("/").filter(Boolean).pop() ?? "local-model";
					const cfg = config();
					const byId = new Map(cfg.models.map((model) => [model.id, model]));
					let entry = byId.get(name);
					let action;
					if (entry !== undefined && entry.repo === dir) {
						action = "existing";
					} else if (entry !== undefined) {
						entry = { ...entry, repo: dir };
						action = "updated";
					} else {
						entry = { id: name, repo: dir, name };
						action = "added";
					}
					byId.set(entry.id, entry);
					// 去重:同一模型只保留一个条目(按模型名归一化匹配)
					const deduped = dedupeModels([...byId.values()], server.status().modelId);
					const update = getSettingsUpdate();
					if (update === null) throw new Error("设置服务不可用,无法保存模型目录");
					await update({ models: deduped.models });
					value = { action, model: { id: entry.id, repo: entry.repo }, removed: deduped.removed, message: "已加入模型列表(未启动),可在下拉中选择切换" };
					break;
				}
				case "prune": {
					// 清理:移除权重文件不可用的模型条目(正在服务的保留);
					// 若默认模型被移除,同步重置 defaultModel。
					const cfg = config();
					const update = getSettingsUpdate();
					if (update === null) throw new Error("设置服务不可用,无法保存模型目录");
					const pruned = pruneMissingModels(cfg.models, server.status().modelId);
					const patch = { models: pruned.models };
					if (cfg.defaultModel !== "" && !pruned.models.some((model) => model.id === cfg.defaultModel)) {
						patch.defaultModel = "";
					}
					if (pruned.removed.length > 0) {
						await update(patch);
					}
					value = {
						removed: pruned.removed,
						defaultModel: pruned.removed.length > 0 ? (patch.defaultModel ?? cfg.defaultModel) : cfg.defaultModel,
						models: pruned.models.map((model) => ({
							id: model.id,
							repo: model.repo,
							name: model.name ?? model.id,
							weightAvailable: modelWeightsAvailable(model)
						}))
					};
					break;
				}
				default:
					writeJson(res, 404, { ok: false, error: { code: "not-found", message: `未知方法 ${method}` } });
					return;
			}
			writeJson(res, 200, { ok: true, value });
		} catch (error) {
			writeJson(res, 200, { ok: false, error: { code: "error", message: error?.message ?? String(error) } });
		}
	};
	ctx.inject(["webServer"], (sctx) => {
		ctx.effect(() => sctx.webServer.register({
			kind: "prefix",
			path: "/mlx/api",
			handler: respond
		}), "dsh-mlx-local: /mlx/api routes");
	});
}
//#endregion

//#region 8. 插件装配
/** 插件名(与 cordis.patch.yml 的入口名一致)。 */
export const name = "dsh-mlx-local";
/** 注入的服务。 */
export const inject = ["llm"];
/** 启动探针:apply 各阶段与启动链写入文件,便于离线诊断。 */
const BOOT_LOG_PATH = () => join(expandHome("~/.dsh/mlx/logs"), "plugin-boot.log");
function bootLog(message) {
	try {
		mkdirSync(expandHome("~/.dsh/mlx/logs"), { recursive: true });
		appendFileSync(BOOT_LOG_PATH(), `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* 探针失败不影响运行 */
	}
}
/**
 * 插件入口:装配配置、环境、服务、设置卡片与生命周期。
 * 配置经 installSettingsSection 挂到设置命名空间,修改即时生效
 * (模型目录/端口等下次启动服务时采用)。
 *
 * 注意:本插件**既不注册系统提示词段,也不注册任何工具**。它是"把本地模型
 * 跑起来"的基础设施,全部操作都在设置页「MLX 模型」栏目完成;这样任何会话
 * 都不会因为装了本插件而多付固定的提示词/schema 成本。
 */
export function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const cfg = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== undefined) return lastGood;
		try {
			const next = resolveConfig(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === undefined) throw error;
			lastRaw = raw;
			ctx.logger.error("dsh-mlx-local: 配置无效,保留最后有效配置");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	cfg();
	const ring = new LogRing(200);
	const log = (line) => {
		ring.push(line);
		ctx.logger.info(`[dsh-mlx-local] ${line}`);
	};
	const env = new MlxEnvironment({
		venvDir: cfg().venvDir,
		pythonBin: cfg().pythonBin,
		log
	});
	const server = new MlxServer({
		env,
		config: cfg,
		log,
		ring
	});
	// 进程退出前的同步兜底:无论 dispose 是否执行,SIGKILL 服务进程组。
	// 监听器在 dispose 时移除,避免热插拔后旧实例继续持有退出清理逻辑。
	const onProcessExit = () => {
		server.killNow("SIGKILL");
	};
	process.once("exit", onProcessExit);
	// 设置写入能力(可选:没有 settings 服务时模型目录变更仅提示)。
	let settingsUpdate = null;
	let settingsService = null;
	ctx.inject(["settings"], (sctx) => {
		settingsService = sctx.settings;
		settingsUpdate = (patch) => sctx.settings.update(NS, patch);
	});
	// 把用户的 openai-completions 自定义提供方模型升级为"思考模型":
	// 为指向本地 MLX 服务的 Qwen3 模型补上 reasoningEfforts + compat,
	// 这样主界面模型选择器会像其他思考模型一样显示思考强度开关。
	const LLM_PI_AI_NS = "llm-pi-ai";
	let customProviderReasoningDone = false;
	let customProviderReasoningAttempts = 0;
	let customProviderReasoningTimer = null;
	const ensureCustomProviderReasoning = async () => {
		if (customProviderReasoningDone || settingsService === null) return;
		if (customProviderReasoningTimer !== null) {
			clearTimeout(customProviderReasoningTimer);
			customProviderReasoningTimer = null;
		}
		let section;
		try {
			section = settingsService.get(LLM_PI_AI_NS);
		} catch {
			section = undefined;
		}
		if (section?.providers === undefined || Object.keys(section.providers).length === 0) {
			// llm-pi-ai 设置可能在异步加载中(未加载时 providers 为空对象);
			// 稍后重试,直到拿到真正的 provider 列表。
			if (customProviderReasoningAttempts < 30) {
				customProviderReasoningAttempts += 1;
				customProviderReasoningTimer = setTimeout(() => {
					customProviderReasoningTimer = null;
					void ensureCustomProviderReasoning();
				}, 1_000);
			}
			return;
		}
		customProviderReasoningDone = true;
		const patches = {};
		for (const [route, provider] of Object.entries(section.providers)) {
			if (provider?.api !== "openai-completions") continue;
			const baseURL = typeof provider.baseURL === "string" ? provider.baseURL : "";
			if (!baseURL.includes("127.0.0.1") && !baseURL.includes("localhost")) continue;
			const models = Array.isArray(provider.models) ? provider.models : [];
			const upgraded = models.map((model) => {
				if (model?.reasoningEfforts !== undefined || model?.compat?.thinkingFormat !== undefined) return model;
				if (!/qwen\s*3/i.test(`${model?.id ?? ""} ${model?.name ?? ""}`)) return model;
				return {
					...model,
					reasoningEfforts: { off: null, high: "on" },
					// qwen 是 llm-pi-ai 当前版本 schema 允许的 thinkingFormat;
					// 它只负责让模型选择器显示思考强度,实际请求会被本插件
					// 的 llm/stream 拦截器改写为 chat_template_kwargs。
					compat: { ...(model.compat ?? {}), thinkingFormat: "qwen" }
				};
			});
			if (upgraded.some((model, index) => model !== models[index])) {
				patches[route] = { models: upgraded };
			}
		}
		if (Object.keys(patches).length > 0) {
			try {
				await settingsService.update(LLM_PI_AI_NS, { providers: patches });
				ctx.logger.info("dsh-mlx-local: 已为本地 Qwen3 自定义提供方补全思考强度配置");
			} catch (error) {
				ctx.logger.warn(`dsh-mlx-local: 更新 llm-pi-ai 思考强度配置失败: ${error?.message ?? error}`);
			}
		}
	};
	// 启动链:等设置层合并完成后调度执行。DSH 启动时 settings 文件是异步
	// 加载的,apply 阶段 cfg() 读到的是默认配置;onChange 在 register 后与
	// 每次设置变化(含文件加载完成)时触发,此时 cfg() 已返回用户配置。
	// 本链只做「接管已在运行的外部服务 + 起后台端口监控」,**不会主动拉起
	// 服务**——启动服务一律由用户在设置页显式触发。
	let bootTimer = null;
	let bootRan = false;
	const runBootChain = () => {
		if (bootRan) return;
		bootRan = true;
		bootLog(`boot: 启动链执行(defaultModel=${cfg().defaultModel})`);
		server.adopt().catch((error) => {
			bootLog(`boot: adopt 失败: ${error?.message ?? error}`);
			ctx.logger.warn(`dsh-mlx-local: 接管外部服务失败: ${error?.message ?? error}`);
		}).then((adopted) => {
			bootLog(`boot: adopt 完成(adopted=${String(adopted)})`);
			return undefined;
		}).finally(() => {
			bootLog("boot: 启动后台端口监控");
			server.startPromoteTimer();
			void ensureCustomProviderReasoning();
		});
	};
	const scheduleBoot = () => {
		if (bootTimer !== null) return;
		bootTimer = setTimeout(() => {
			bootTimer = null;
			runBootChain();
		}, 500);
	};
	// 设置就绪后把 Config 挂到 NS:settings 服务在场时以用户配置为准,
	// 服务卸载时回落到插件自身传入的 config。
	ctx.inject(["settings"], (sctx) => {
		sctx.settings.installSection(ctx, NS, Config, config, {
			setSource: (source) => {
				current = source;
			},
			onChange: () => {
				/* 设置就绪/变化 → 调度启动链(每次请求也读最新配置) */
				scheduleBoot();
				void ensureCustomProviderReasoning();
			}
		});
	});
	registerMlxApi(ctx, { server, env, config: cfg, getSettingsUpdate: () => settingsUpdate });
	// 拦截已有的本地自定义提供方请求(不注册任何新 provider):
	// 这样模型选择器仍由 llm-pi-ai 负责,思考强度也走主界面选择,
	// 但实际请求由本插件直接发给 mlx_lm.server,并正确下发 chat_template_kwargs。
	installLocalLlmInterceptor(ctx, {
		config: cfg,
		server,
		settingsService: () => settingsService,
		llmPiAiNs: LLM_PI_AI_NS
	});
	// 卸载清理必须走 ctx.effect:cordis 4.x 只派发 internal/* 事件,**没有 dispose
	// 事件**(全运行时无人发出、官方插件也无人订阅),ctx.on("dispose", …) 是死代码,
	// 永远不会触发。effect 体立即执行、其返回的函数在 fiber 卸载时执行。
	ctx.effect(() => () => {
		// 退出/停用/热插拔时确保不留孤儿:先同步 SIGTERM 服务进程组 +
		// 端口上的 Python 进程,再派发 detached 清理脚本兜底 SIGKILL。
		// 即使 DSH 随后被强杀,监督进程也会在父 pid 消失后清理 python。
		process.removeListener("exit", onProcessExit);
		if (bootTimer !== null) {
			clearTimeout(bootTimer);
			bootTimer = null;
		}
		if (customProviderReasoningTimer !== null) {
			clearTimeout(customProviderReasoningTimer);
			customProviderReasoningTimer = null;
		}
		server.disposeSync();
		const port = server.port ?? cfg().port;
		const pids = [...new Set([
			...(server.pid !== null && server.pid !== undefined ? [server.pid] : []),
			...(server.child?.pid !== undefined ? [server.child.pid] : []),
			...pythonListenPidsOf(port)
		])];
		if (pids.length > 0) {
			const script = `sleep 1; for p in ${pids.join(" ")}; do kill "$p" 2>/dev/null; kill -- "-$p" 2>/dev/null; done; sleep 3; for p in ${pids.join(" ")}; do kill -9 "$p" 2>/dev/null; kill -9 -- "-$p" 2>/dev/null; done`;
			try {
				const cleaner = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
				cleaner.unref();
			} catch {
				/* 清理进程派发失败时,进程退出后由新实例 adopt 兜底 */
			}
			ctx.logger.info(`dsh-mlx-local: 退出清理已派发(pid ${pids.join(",")})`);
		}
	}, "dsh-mlx-local: 卸载时回收本地模型服务");
	bootLog("apply: dispose 注册完成");
}
//#endregion

export { Config, MlxServer, resolveConfig };
export default { name, inject, Config, apply };
