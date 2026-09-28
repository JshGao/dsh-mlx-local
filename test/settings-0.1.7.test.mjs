/**
 * 0.1.7+ 设置架构的回归测试。
 *
 * 这一层曾经整体失效却没有任何报错:DSH 0.1.7 把 `settings.installSection`
 * 与 `settings.get` 删掉后,插件的 `ctx.inject(["settings"], …)` 回调照常执行、
 * 执行到一半抛 TypeError,`scheduleBoot()` 因此永不触发,设置页也不再显示本插件
 * 的任何字段。这里把新契约固定下来,避免再靠"界面上看不见"来发现问题。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Config, plainConfigValue, resolveConfig } from "../lib/index.js";

/** 与 cosmokit 共用同一个全局 symbol——跨 ESM/CJS 副本也认得出。 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** 造一个与 loader 传入形态一致的 volatile 引用。 */
function volatileRef(value) {
	let current = value;
	return {
		get: () => current,
		[VOLATILE_WRITE]: (next) => {
			current = next;
		}
	};
}

test("Config: 每个字段都标了 volatile,否则设置页不显示、update 会被拒", () => {
	// dsh-settings 的 volatileForm() 会跳过没有 volatile 字段的条目,write() 也会
	// 以 "has no volatile fields" 抛错——两件事都只表现为"设置页什么都没有"。
	const missing = Object.entries(Config.dict ?? {})
		.filter(([, field]) => field.meta?.volatile !== true)
		.map(([key]) => key);
	assert.deepEqual(missing, [], `这些字段缺少 .volatile(): ${missing.join(", ")}`);
});

test("plainConfigValue: 解包 volatile 引用,产出可交给 resolveConfig 的纯数据", () => {
	const raw = {
		port: volatileRef(9000),
		host: "127.0.0.1",
		models: volatileRef([{ id: "m1", repo: "/tmp/m1" }])
	};
	const plain = plainConfigValue(raw);
	assert.equal(plain.port, 9000);
	assert.equal(plain.host, "127.0.0.1");
	assert.deepEqual(plain.models, [{ id: "m1", repo: "/tmp/m1" }]);
	// 不解包的话 port 会是 {get(){…}}、models 会是非数组,schema 校验随即失败。
	assert.equal(resolveConfig(plain).port, 9000);
});

test("plainConfigValue: 原地写回后读到新值(设置页改动的更新路径)", () => {
	// loader 更新 volatile 值时是原地写回,config 对象标识始终不变,所以缓存
	// 不能按对象标识判断——这条用例守着那个坑。
	const ref = volatileRef(8080);
	const raw = { port: ref };
	assert.equal(plainConfigValue(raw).port, 8080);
	ref[VOLATILE_WRITE](9999);
	assert.equal(plainConfigValue(raw).port, 9999);
});

test("plainConfigValue: 普通值原样保留,嵌套结构不被改写", () => {
	const raw = { port: 8080, extra: { nested: [1, 2] }, flag: true };
	assert.deepEqual(plainConfigValue(raw), { port: 8080, extra: { nested: [1, 2] }, flag: true });
});

test("resolveConfig: 接受解包后的默认配置", () => {
	const config = resolveConfig(plainConfigValue({ port: volatileRef(8080) }));
	assert.equal(config.port, 8080);
	assert.equal(config.host, "127.0.0.1");
});
