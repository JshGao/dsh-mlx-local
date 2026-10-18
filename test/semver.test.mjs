/**
 * scripts/semver-lite.mjs 的回归测试。
 *
 * 重点是预发布规则:检查器第 7 项(peerDependencies 范围)依赖它把
 * 「代码兼容但装不上」的情况判出来。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseVersion, satisfiesRange } from "../scripts/semver-lite.mjs";

test("parseVersion / compareVersions: 基本排序与 prerelease", () => {
	assert.deepEqual(parseVersion("0.2.1-rc.2"), { major: 0, minor: 2, patch: 1, prerelease: ["rc", "2"] });
	assert.equal(parseVersion("nope"), null);
	assert.ok(compareVersions(parseVersion("0.2.1"), parseVersion("0.2.1-rc.2")) > 0);
	assert.ok(compareVersions(parseVersion("0.2.1-rc.10"), parseVersion("0.2.1-rc.2")) > 0);
	assert.equal(compareVersions(parseVersion("1.0.0"), parseVersion("1.0.0")), 0);
});

test("satisfiesRange: 预发布版本只与同 tuple 的预发布范围比较", () => {
	// 本轮实际坑:0.2.1-rc.2 落在 ^0.2.0-rc.1 之外,尽管代码完全兼容。
	assert.equal(satisfiesRange("0.2.1-rc.2", "^0.2.0-rc.1"), false);
	assert.equal(satisfiesRange("0.2.1-rc.2", "^0.2.1-rc.1"), true);
	assert.equal(satisfiesRange("0.2.1-rc.2", "^0.1.7-rc.1 || ^0.2.0-rc.1"), false);
	assert.equal(satisfiesRange("0.2.1-rc.2", "^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1"), true);
	assert.equal(satisfiesRange("0.2.0-rc.2", "^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1"), true);
	assert.equal(satisfiesRange("0.1.7-rc.2", "^0.1.7-rc.1 || ^0.2.0-rc.1"), true);
});

test("satisfiesRange: caret / tilde / 比较器 / 精确版本", () => {
	assert.equal(satisfiesRange("3.18.5", "^3.18.3"), true);
	assert.equal(satisfiesRange("4.0.5", "^4.0.4"), true);
	assert.equal(satisfiesRange("1.5.0", "^1.2.3"), true);
	assert.equal(satisfiesRange("2.0.0", "^1.2.3"), false);
	assert.equal(satisfiesRange("0.3.0", "^0.2.3"), false);
	assert.equal(satisfiesRange("1.2.9", "~1.2.3"), true);
	assert.equal(satisfiesRange("1.3.0", "~1.2.3"), false);
	assert.equal(satisfiesRange("1.2.3", ">=1.2.3 <1.3.0"), true);
	assert.equal(satisfiesRange("1.3.0", ">=1.2.3 <1.3.0"), false);
	assert.equal(satisfiesRange("1.2.3", "1.2.3"), true);
	assert.equal(satisfiesRange("1.2.4", "1.2.3"), false);
	assert.equal(satisfiesRange("1.2.3", "not-a-range"), false);
});
