import assert from "node:assert/strict";
import test from "node:test";
import { HOST_CODE, CLIENT_CODE } from "../dsh-mlx-local.dyn.js";

test("dynamic template code parses as JavaScript", () => {
	assert.doesNotThrow(() => new Function(HOST_CODE));
	assert.doesNotThrow(() => new Function(CLIENT_CODE));
});

test("dynamic template derives home/config path at runtime", () => {
	assert.equal(HOST_CODE.includes("/Users/jianshun/.dsh/mlx/config.json"), false);
	assert.equal(HOST_CODE.includes("const CONFIG_PATH"), false);
	assert.match(HOST_CODE, /configPath = async/);
});
