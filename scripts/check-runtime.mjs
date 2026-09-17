#!/usr/bin/env node
/**
 * 校验插件与真实 DSH 运行时的兼容性。六类检查,全部以目标运行时为准:
 *
 * 1. 服务端具名导入:lib/*.js 里 `import { X } from "@deepseek-ai/..."` 的每个 X
 *    是否真的被导出。ESM 的具名导入缺失是**链接期**错误,插件会直接加载失败。
 * 2. 服务名:服务端 `export const inject = [...]` 与客户端 `const inject = [...]`
 *    声明的每个服务,运行时里是否真有插件提供。
 * 3. 服务方法:`<接收者>.<服务>.<方法>(...)` 里的方法,是否出现在提供该服务的包里。
 *    `ctx.tools.register` / `sctx.settings.installSection` / `ctx.uiWorkspace.pickDirectory`
 *    都走这条。**服务存在 ≠ 方法存在**(例如 `workspaces` 与 `uiWorkspace` 并存),
 *    所以这一层不能省。
 * 4. 订阅事件:`ctx.on("事件名", …)` 订阅的事件,运行时里是否确有包发出。事件改名
 *    不报错,订阅方只是永远不再触发。
 * 5. 界面槽:客户端 `ctx.slots.inject("槽名", …)` 的槽名,运行时里是否有别的包在用。
 *    槽名没有中心注册表,官方包靠各自 `slots.inject` 声明;改名的后果是注册
 *    **静默落空**——设置页上整个栏目消失,而控制台一行错都不报。
 * 6. 客户端模块图:`package.json` 的 `dsh.client.inject` 里每个包名,是否真的在目标
 *    运行时的客户端模块图内(包存在**且**自带 `dsh.client` 声明)。host 只把带该声明
 *    的包编进图,图里没有的名字在浏览器端被静默跳过,顺序保证悄悄失效。
 *
 * 背景:`npm test` 只加载本仓库的 node_modules,发现不了上述漂移——插件最初对着
 * `0.1.0-rc.6` 写,却在 `0.1.5-rc.1` 上炸了两次(缺失导出、改名服务),都是本地全绿。
 *
 * 用法:
 *   node scripts/check-runtime.mjs                    # 从 PATH 上的 dsh 反推安装根
 *   node scripts/check-runtime.mjs <dsh 安装根>        # 显式指定(含 @deepseek-ai/ 的 node_modules)
 *   DSH_RUNTIME_ROOT=<路径> node scripts/check-runtime.mjs
 *
 * 退出码:0 = 全部通过;1 = 有缺失或无法定位运行时。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@deepseek-ai/";

/**
 * 去掉注释,保留字符串字面量。
 *
 * 必须走状态机而不是正则:`lib/index.js` 里有 `"http://x"`,朴素的 `//` 正则会把
 * 它拦腰截断。另外注释里经常出现 API 名字(例如说明"不要用 `ctx.on("dispose")`"),
 * 不剥离就会误报。
 * @param source - 原始源码。
 * @returns 注释被替换为空白的源码,行号与原文一致。
 */
function stripComments(source) {
	let out = "";
	let state = "code";
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		const next = source[i + 1];
		if (state === "code") {
			if (ch === "/" && next === "/") { state = "line"; i += 1; continue; }
			if (ch === "/" && next === "*") { state = "block"; out += "  "; i += 1; continue; }
			if (ch === "'" || ch === '"' || ch === "`") state = ch === "'" ? "single" : ch === '"' ? "double" : "template";
			out += ch;
			continue;
		}
		if (state === "line") {
			if (ch === "\n") { state = "code"; out += ch; }
			continue;
		}
		if (state === "block") {
			if (ch === "*" && next === "/") { state = "code"; out += "  "; i += 1; continue; }
			out += ch === "\n" ? "\n" : " ";
			continue;
		}
		// 字符串/模板字面量内部:原样保留,处理转义。
		out += ch;
		if (ch === "\\") { out += next ?? ""; i += 1; continue; }
		if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) state = "code";
	}
	return out;
}

/** 读取本仓库某个 lib 文件的源码,并剥掉注释。 */
function readSource(file) {
	return stripComments(readFileSync(join(repoRoot, "lib", file), "utf8"));
}

/** 从 start 起向上找到同时包含 `@deepseek-ai` 的 node_modules 目录。 */
function findModulesRoot(start) {
	let dir = realpathSync(start);
	for (;;) {
		const candidate = join(dir, "node_modules");
		if (existsSync(join(candidate, "@deepseek-ai"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** 定位目标运行时的 node_modules:显式参数 > 环境变量 > PATH 上的 dsh。 */
function resolveRuntime() {
	const explicit = process.argv[2] ?? process.env.DSH_RUNTIME_ROOT;
	if (explicit !== undefined && explicit !== "") {
		const absolute = resolve(explicit);
		if (existsSync(join(absolute, "@deepseek-ai"))) return absolute;
		const nested = join(absolute, "node_modules");
		if (existsSync(join(nested, "@deepseek-ai"))) return nested;
		const found = findModulesRoot(absolute);
		if (found !== undefined) return found;
		throw new Error(`在 ${explicit} 下找不到 @deepseek-ai,请传入含该 scope 的 node_modules 目录`);
	}
	let bin;
	try {
		bin = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
	} catch {
		throw new Error("PATH 上没有 dsh;请显式传入 DSH 安装根,或设置 DSH_RUNTIME_ROOT");
	}
	if (bin === "") throw new Error("PATH 上没有 dsh;请显式传入 DSH 安装根,或设置 DSH_RUNTIME_ROOT");
	const found = findModulesRoot(bin);
	if (found === undefined) throw new Error(`从 ${bin} 出发找不到含 @deepseek-ai 的 node_modules`);
	return found;
}

/**
 * 抽取一段 import 子句里的具名导入,忽略默认导出与命名空间导入。
 * @param clause - `from` 之前的部分,例如 `z` 或 `{ a, b as c }` 或 `React, { useState }`。
 * @returns 具名导入的原始名(不含 `as` 别名)。
 */
function namedImportsOf(clause) {
	const open = clause.indexOf("{");
	if (open === -1) return [];
	const close = clause.indexOf("}", open);
	if (close === -1) return [];
	return clause
		.slice(open + 1, close)
		.split(",")
		.map((part) => part.trim().split(/\s+as\s+/)[0].trim())
		.filter((name) => name !== "");
}

/** 本仓库参与检查的源文件:client.js 是浏览器半边,其余是服务端半边。 */
function sourceFiles() {
	const all = readdirSync(join(repoRoot, "lib")).filter((name) => name.endsWith(".js")).sort();
	return {
		server: all.filter((name) => name !== "client.js"),
		client: all.filter((name) => name === "client.js")
	};
}

/** 从已解析的模块文件出发,向上找到名字匹配的 package.json 并读取 version。 */
function versionOf(specifier, fromFile) {
	let dir = dirname(fromFile);
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const pkg = JSON.parse(readFileSync(manifest, "utf8"));
			if (pkg.name === specifier) return pkg.version ?? "?";
		}
		const parent = dirname(dir);
		if (parent === dir) return "?";
		dir = parent;
	}
}

/** 扫描服务端源文件,汇总每个 @deepseek-ai 包被具名导入的符号及其出处。 */
function collectRequiredSymbols(files) {
	const importRe = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
	const required = new Map();
	for (const file of files) {
		const source = readSource(file);
		for (const match of source.matchAll(importRe)) {
			const specifier = match[2];
			if (!specifier.startsWith(SCOPE)) continue;
			const symbols = namedImportsOf(match[1]);
			if (symbols.length === 0) continue;
			const bySymbol = required.get(specifier) ?? new Map();
			for (const symbol of symbols) {
				const origins = bySymbol.get(symbol) ?? new Set();
				origins.add(file);
				bySymbol.set(symbol, origins);
			}
			required.set(specifier, bySymbol);
		}
	}
	return required;
}

/**
 * 收集运行时每个包提供的 cordis 服务名,及其源码全文。
 *
 * 一个服务可能被多个包提供(可替换实现),所以按名合并、方法取并集。
 * 方法是否存在用「提供该服务的包里出现过 `<方法>(`」判定:偏宽松,宁可漏报
 * 也不误报。它抓不住的只有「同文件里两个服务、方法名恰好撞上」。
 * @param fileRole - `index.js`(服务端)或 `client.js`(浏览器端)。
 * @returns 服务名 → { packages, sources }。
 */
function collectServices(modulesRoot, fileRole) {
	const scopeDir = join(modulesRoot, SCOPE);
	const services = new Map();
	let packages;
	try {
		packages = readdirSync(scopeDir);
	} catch {
		return services;
	}
	for (const pkg of packages) {
		const file = join(scopeDir, pkg, "lib", fileRole);
		if (!existsSync(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/super\(ctx,\s*"([A-Za-z_$][\w$]*)"\)/g)) {
			const entry = services.get(match[1]) ?? { packages: new Set(), sources: [] };
			entry.packages.add(pkg);
			entry.sources.push(source);
			services.set(match[1], entry);
		}
	}
	return services;
}

/** 读取 `const inject = [...]` / `export const inject = [...]` 声明的服务名。 */
function declaredServices(file) {
	const source = readSource(file);
	const match = /(?:export )?const inject = \[([^\]]*)\]/.exec(source);
	if (match === null) return [];
	return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

/** 抽出 `<接收者>.<服务>.<方法>(` 三元调用,只保留中间名确实是运行时服务的那些。 */
function serviceCalls(files, services) {
	const calls = new Map();
	const callRe = /\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
	for (const file of files) {
		const source = readSource(file);
		for (const match of source.matchAll(callRe)) {
			const [, service, method] = match;
			if (!services.has(service)) continue;
			const methods = calls.get(service) ?? new Map();
			const origins = methods.get(method) ?? new Set();
			origins.add(file);
			methods.set(method, origins);
			calls.set(service, methods);
		}
	}
	return calls;
}

/**
 * 收集运行时发出的 cordis 事件名。
 *
 * 事件这一层最危险:名字改了**不会报错**,订阅方只是永远不再触发——例如
 * `llm/stream` 若改名,插件会静默失去拦截能力,功能悄悄消失而日志全干净。
 * 所以单独查一遍。
 *
 * 覆盖 `emit` / `parallel` / `serial` / `bail` / `waterfall` 五种派发,
 * 兼容带与不带 `thisArg` 两种调用形状。
 * @returns 事件名集合。
 */
function collectEvents(modulesRoot) {
	const scopeDir = join(modulesRoot, SCOPE);
	const events = new Set();
	let packages;
	try {
		packages = readdirSync(scopeDir);
	} catch {
		return events;
	}
	const patterns = [
		/\.(?:emit|parallel|serial|bail|waterfall)\(\s*"([^"]+)"/g,
		/\.(?:emit|parallel|serial|bail|waterfall)\(\s*[^,"'()]+,\s*"([^"]+)"/g
	];
	for (const pkg of packages) {
		const file = join(scopeDir, pkg, "lib", "index.js");
		if (!existsSync(file)) continue;
		const source = readFileSync(file, "utf8");
		for (const pattern of patterns) {
			for (const match of source.matchAll(pattern)) events.add(match[1]);
		}
	}
	return events;
}

/** 本仓库 `ctx.on("事件名", ...)` 订阅的事件及其出处。 */
function subscribedEvents(files) {
	const subscribed = new Map();
	for (const file of files) {
		const source = readSource(file);
		for (const match of source.matchAll(/ctx\.on\(\s*"([^"]+)"/g)) {
			const origins = subscribed.get(match[1]) ?? new Set();
			origins.add(file);
			subscribed.set(match[1], origins);
		}
	}
	return subscribed;
}

/** 本仓库 `ctx.slots.inject("槽名", …)` 声明的界面槽及其出处。 */
function declaredSlotNames() {
	const source = readSource("client.js");
	const names = new Map();
	for (const match of source.matchAll(/\.slots\.inject\(\s*"([^"]+)"/g)) {
		const origins = names.get(match[1]) ?? new Set();
		origins.add("client.js");
		names.set(match[1], origins);
	}
	return names;
}

/**
 * 收集目标运行时里每个界面槽的名字 → 使用它的包。
 *
 * 槽没有中心注册表:官方包(settings 各栏目、agent-preset 等)各自用
 * `slots.inject("槽名", …)` 领用,所以"运行时里有没有别的包用这个名字"
 * 就是槽是否还存在的唯一判据。
 * @returns 槽名 → 包名集合。
 */
function collectRuntimeSlots(modulesRoot) {
	const scopeDir = join(modulesRoot, SCOPE);
	const slots = new Map();
	let packages;
	try {
		packages = readdirSync(scopeDir);
	} catch {
		return slots;
	}
	for (const pkg of packages) {
		const file = join(scopeDir, pkg, "lib", "client.js");
		if (!existsSync(file)) continue;
		const source = stripComments(readFileSync(file, "utf8"));
		for (const match of source.matchAll(/\.slots\.inject\(\s*"([^"]+)"/g)) {
			const owners = slots.get(match[1]) ?? new Set();
			owners.add(pkg);
			slots.set(match[1], owners);
		}
	}
	return slots;
}

/** 读取本仓库 package.json 的 `dsh.client` 声明。 */
function declaredClientManifest() {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	return pkg.dsh?.client ?? {};
}

/**
 * 校验 `dsh.client.inject` 的每个包名确实落在目标运行时的客户端模块图内。
 *
 * 两种失败形态都不报错、只在浏览器里静默跳过(`if (dependency !== void 0)`):
 * 包根本没装,或者装了但没有 `dsh.client` 声明因而不被编进图。后者尤其隐蔽——
 * `@deepseek-ai/dsh-client-ui-slots` 就属于这类:它只是官方包的 devDependency,
 * 自身不带 dsh.client,写进 inject 永远不会生效(0.4.1 及以前如此)。
 * @returns 失败条数。
 */
function checkClientInjectGraph(modulesRoot, names) {
	console.log("\ndsh.client.inject 的模块图存在性\n");
	if (names.length === 0) {
		console.log("(package.json 未声明 dsh.client.inject)");
		return 0;
	}
	let failures = 0;
	for (const name of names) {
		const manifest = name.startsWith(SCOPE)
			? join(modulesRoot, SCOPE, name.slice(SCOPE.length), "package.json")
			: join(modulesRoot, name, "package.json");
		if (!existsSync(manifest)) {
			failures += 1;
			console.log(`✗ ${name} — 目标运行时里没有这个包,注入会被静默跳过`);
			continue;
		}
		let decl;
		try {
			decl = JSON.parse(readFileSync(manifest, "utf8")).dsh?.client;
		} catch {
			decl = undefined;
		}
		if (decl === undefined) {
			failures += 1;
			console.log(`✗ ${name} — 包存在但没有 dsh.client 声明,不进客户端模块图,注入会被静默跳过`);
			continue;
		}
		console.log(`✓ ${name} (platform=${decl.platform ?? "?"})`);
	}
	return failures;
}

/**
 * 校验半边代码:声明的服务存在、调用的方法存在。
 * @returns 失败条数。
 */
function checkHalf(label, files, services, injectDecls) {
	console.log(`\n${label}\n`);
	let failures = 0;
	const declared = new Set();
	for (const { file, names } of injectDecls) {
		for (const name of names) declared.add(name);
		console.log(`inject(${files.join(", ")} → ${file}): ${names.join(", ") || "(空)"}`);
	}
	const calls = serviceCalls(files, services);

	for (const name of [...new Set([...declared, ...calls.keys()])].sort()) {
		const entry = services.get(name);
		if (entry === undefined) {
			failures += 1;
			console.log(`✗ ${name} — 没有任何 DSH 插件(${label.includes("服务端") ? "服务端" : "客户端"})提供该服务`);
			continue;
		}
		const byMethod = calls.get(name) ?? new Map();
		const missing = [...byMethod.keys()]
			.filter((method) => !entry.sources.some((source) => source.includes(`${method}(`)))
			.sort();
		if (missing.length === 0) {
			const used = [...byMethod.keys()].sort();
			console.log(`✓ ${name} (${[...entry.packages].sort().join(", ")})${used.length === 0 ? "" : ` — 用到 ${used.join(", ")}`}`);
			continue;
		}
		failures += 1;
		console.log(`✗ ${name} (${[...entry.packages].sort().join(", ")})`);
		for (const method of missing) {
			console.log(`    缺失方法 ${method} — 引用位置: ${[...byMethod.get(method)].join(", ")};该服务由 ${[...entry.packages].sort().join(", ")} 提供,其中没有这个方法`);
		}
	}
	return failures;
}

const modulesRoot = resolveRuntime();
const require = createRequire(join(modulesRoot, "__check-runtime__.js"));
const { server: serverFiles, client: clientFiles } = sourceFiles();
const required = collectRequiredSymbols(serverFiles);

console.log(`运行时: ${modulesRoot}`);
console.log(`校验 ${required.size} 个 @deepseek-ai 包(来自 ${serverFiles.map((f) => `lib/${f}`).join(", ")} 的具名导入)\n`);

let failures = 0;
for (const [specifier, bySymbol] of [...required].sort(([a], [b]) => a.localeCompare(b))) {
	let exportsOf;
	let version = "?";
	try {
		const resolved = require.resolve(specifier);
		version = versionOf(specifier, resolved);
		exportsOf = await import(pathToFileURL(resolved).href);
	} catch (error) {
		failures += 1;
		console.log(`✗ ${specifier}`);
		console.log(`    无法导入: ${error.message}`);
		continue;
	}
	const missing = [...bySymbol.keys()].filter((symbol) => !(symbol in exportsOf)).sort();
	if (missing.length === 0) {
		console.log(`✓ ${specifier}@${version}`);
		continue;
	}
	failures += 1;
	console.log(`✗ ${specifier}@${version}`);
	for (const symbol of missing) console.log(`    缺失导出 ${symbol} — 引用位置: ${[...bySymbol.get(symbol)].join(", ")}`);
}

failures += checkHalf("服务端服务(lib/index.js 等)", serverFiles, collectServices(modulesRoot, "index.js"), [
	{ file: "index.js", names: declaredServices("index.js") }
]);
failures += checkHalf("客户端服务(lib/client.js)", clientFiles, collectServices(modulesRoot, "client.js"), [
	{ file: "client.js", names: declaredServices("client.js") }
]);

console.log("\n订阅的事件\n");
const events = collectEvents(modulesRoot);
for (const [name, origins] of [...subscribedEvents(serverFiles)].sort(([a], [b]) => a.localeCompare(b))) {
	if (events.has(name)) {
		console.log(`✓ ${name} — 订阅位置: ${[...origins].join(", ")}`);
		continue;
	}
	failures += 1;
	console.log(`✗ ${name} — 目标运行时里没有任何包发出该事件(改名会静默失效,不会报错)`);
	console.log(`    订阅位置: ${[...origins].join(", ")}`);
}

failures += checkClientInjectGraph(modulesRoot, declaredClientManifest().inject ?? []);

console.log("\n界面槽\n");
const runtimeSlots = collectRuntimeSlots(modulesRoot);
for (const [name, origins] of [...declaredSlotNames()].sort(([a], [b]) => a.localeCompare(b))) {
	const owners = runtimeSlots.get(name);
	if (owners !== undefined) {
		console.log(`✓ ${name} — 目标运行时中 ${[...owners].sort().join(", ")} 也在用该槽`);
		continue;
	}
	failures += 1;
	console.log(`✗ ${name} — 目标运行时里没有任何包使用该槽(槽名改了,注册会静默落空)`);
	console.log(`    领用位置: ${[...origins].join(", ")}`);
}

if (failures > 0) {
	console.log(`\n${failures} 处不兼容;插件在目标运行时上会加载失败、报错或静默失效。`);
	process.exit(1);
}
console.log("\n服务端导入、服务名、服务方法、订阅事件、客户端注入与界面槽在目标运行时中全部存在。");
