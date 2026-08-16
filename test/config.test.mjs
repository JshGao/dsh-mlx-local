import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../lib/index.js";

test("resolveConfig: defaults for MLX service options", () => {
	const config = resolveConfig({});
	assert.equal(config.autoStart, false);
	assert.equal(config.host, "127.0.0.1");
	assert.equal(config.port, 8080);
});

test("resolveConfig: infers Qwen3 thinking for legacy model ids", () => {
	const config = resolveConfig({
		models: [{ id: "mlx-community-Qwen3-8B-4bit", repo: "/tmp/qwen3", name: "Qwen3" }]
	});
	assert.equal(config.models[0].thinking, true);
});

test("resolveConfig: rejects invalid serverArgs and thinkMode", () => {
	assert.throws(() => resolveConfig({ serverArgs: "bad" }), /serverArgs/);
	assert.throws(() => resolveConfig({ thinkMode: "sometimes" }), /thinkMode/);
	assert.throws(() => resolveConfig({ port: 70000 }), /port/);
	assert.throws(() => resolveConfig({ models: [{ id: "a", repo: "x" }, { id: "a", repo: "y" }] }), /重复/);
});

test("resolveConfig: validates defaultModel against model catalog", () => {
	const config = resolveConfig({ defaultModel: "qwen3-8b" });
	assert.equal(config.defaultModel, "qwen3-8b");
	assert.throws(() => resolveConfig({ defaultModel: "missing" }), /不在模型目录/);
});
