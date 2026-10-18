/**
 * lib/local.js 的回归测试。
 *
 * 这一层是 index.js(思考强度补全)与 stream.js(llm/stream 拦截器)共用的
 * 判据。此前两处各写一份 `baseURL.includes("127.0.0.1")`,会把
 * `https://example.com/?next=127.0.0.1` 之类的地址误判成本机服务。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isLocalOpenAiProvider, isLoopbackHostname, originOf } from "../lib/local.js";

test("isLoopbackHostname: 127.0.0.0/8、localhost、::1", () => {
	for (const name of ["localhost", "127.0.0.1", "127.0.0.2", "127.1.2.3", "::1"]) {
		assert.equal(isLoopbackHostname(name), true, name);
	}
	for (const name of ["localhost.", "0.0.0.0", "192.168.1.5", "example.com", "127.0.0.256", "", undefined]) {
		assert.equal(isLoopbackHostname(name), false, String(name));
	}
});

test("isLocalOpenAiProvider: 只认 openai-completions + 回环 baseURL", () => {
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "http://127.0.0.1:8080/v1" }), true);
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "http://localhost:8080/v1" }), true);
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "http://[::1]:8080/v1" }), true);
	// 协议不同、或根本不是 URL
	assert.equal(isLocalOpenAiProvider({ api: "anthropic", baseURL: "http://127.0.0.1:8080/v1" }), false);
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "127.0.0.1:8080" }), false);
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "not a url" }), false);
	assert.equal(isLocalOpenAiProvider(undefined), false);
});

test("isLocalOpenAiProvider: 不把含 127.0.0.1 的远程地址误判成本机", () => {
	// 旧实现用 includes():这两个都会被误判,进而被拦截器接管,由本机发出请求。
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "https://example.com/?next=127.0.0.1" }), false);
	assert.equal(isLocalOpenAiProvider({ api: "openai-completions", baseURL: "https://localhost.evil.com/v1" }), false);
});

test("isLocalOpenAiProvider: 服务绑到局域网地址时按 origin 识别", () => {
	const provider = { api: "openai-completions", baseURL: "http://192.168.1.5:8080/v1" };
	assert.equal(isLocalOpenAiProvider(provider), false);
	assert.equal(isLocalOpenAiProvider(provider, new Set(["http://192.168.1.5:8080"])), true);
	// 端口不同不算同一个服务
	assert.equal(isLocalOpenAiProvider(provider, new Set(["http://192.168.1.5:9090"])), false);
});

test("originOf: host/port 规范化,非法输入返回 null", () => {
	assert.equal(originOf("127.0.0.1", 8080), "http://127.0.0.1:8080");
	assert.equal(originOf("::1", 8080), "http://[::1]:8080");
	assert.equal(originOf("192.168.1.5", 8080), "http://192.168.1.5:8080");
	assert.equal(originOf("", 8080), null);
	assert.equal(originOf("127.0.0.1", 0), null);
});
