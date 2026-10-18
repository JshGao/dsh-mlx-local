/**
 * 「本地 MLX 服务」判定工具。
 *
 * 服务端有两处要回答同一个问题:**某个 openai-completions 自定义提供方
 * 是否指向本机的 mlx_lm.server**:
 *
 *   - `lib/index.js` 的 Qwen3 思考强度补全:决定给哪些模型写
 *     `reasoningEfforts` + `compat.thinkingFormat`;
 *   - `lib/stream.js` 的 `llm/stream` 拦截器:决定是否接管请求。
 *
 * 两处判据必须一致,否则会出现「设置页补全了思考强度、拦截器却不接管」
 * 或反之。此前各写一份 `baseURL.includes("127.0.0.1")`,既容易漂移,
 * 又会把 `https://example.com/?next=127.0.0.1` 这类地址误判成本机服务。
 *
 * 判据(顺序):
 *  1. `api` 必须是 `openai-completions`;
 *  2. `baseURL` 必须能被 URL 解析,scheme 是 http/https;
 *  3. 主机名落在回环段(127.0.0.0/8、localhost、::1),或
 *  4. 与该服务实际监听地址同源(插件允许把 mlx 服务绑到局域网地址,
 *     这种配置下 baseURL 不会是回环名)。
 */

/** 回环主机名白名单(URL.hostname 已去掉 IPv6 方括号)。 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

/**
 * 主机名是否是回环地址。
 * @param hostname - `URL.hostname`(小写、无方括号)。
 * @returns 是否回环。
 */
export function isLoopbackHostname(hostname) {
	if (typeof hostname !== "string" || hostname.length === 0) return false;
	// WHATWG URL 的 hostname 对 IPv6 保留方括号(`[::1]`),这里统一去掉。
	const name = hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
	if (LOOPBACK_HOSTNAMES.has(name)) return true;
	// 127.0.0.0/8 整段都是回环:127.0.0.1、127.0.0.2、127.1.2.3 …
	const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
	if (match === null) return false;
	return match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * 解析 baseURL 的 origin;不合法或不是 http(s) 时返回 null。
 * @param baseURL - 自定义提供方的 baseURL。
 * @returns `URL` 实例或 null。
 */
function parseBaseURL(baseURL) {
	if (typeof baseURL !== "string" || baseURL.trim().length === 0) return null;
	let url;
	try {
		url = new URL(baseURL.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	return url;
}

/**
 * 提供方是否指向本机 MLX 服务。
 * @param provider - llm-pi-ai 的提供方条目。
 * @param extraOrigins - 额外的本机 origin(如插件自身服务的 `http://192.168.1.5:8080`),
 *   用于识别「服务绑在局域网地址」的配置。
 * @returns 是否应视为本地服务。
 */
export function isLocalOpenAiProvider(provider, extraOrigins) {
	if (provider?.api !== "openai-completions") return false;
	const url = parseBaseURL(provider.baseURL);
	if (url === null) return false;
	if (isLoopbackHostname(url.hostname)) return true;
	if (extraOrigins === undefined || extraOrigins === null) return false;
	for (const origin of extraOrigins) {
		if (typeof origin === "string" && origin.length > 0 && url.origin === origin) return true;
	}
	return false;
}

/**
 * 由 host/port 拼出 origin;非法时返回 null。
 * @param host - 监听地址或主机名。
 * @param port - 端口。
 * @returns 规范化 origin 或 null。
 */
export function originOf(host, port) {
	if (typeof host !== "string" || host.length === 0) return null;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	try {
		return new URL(`http://${bracketed}:${port}`).origin;
	} catch {
		return null;
	}
}
