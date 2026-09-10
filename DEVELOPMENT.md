# 开发指南

面向在本仓库上继续开发的人。安装与使用见 [README.md](README.md),故障排查见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

> **本机当前状态**:0.4.0 已打包并通过 `dsh plugin --profile web add` 装进 `~/.dsh/profiles/web`,profile 的 `dsh.profile.bundles` 已包含 `dsh-mlx-local`。**重启 DSH 后生效**。安装源是本地 tgz(`file:` 绝对路径),重新打包后需要重新 `add` 才会更新。

## 环境准备

| 项目 | 要求 |
|---|---|
| Node | >= 20(本仓库在 Node 26.5.0 上验证) |
| DSH | 用于联调;`dsh --version` 可查 |
| Python | 仅在真实启动 `mlx_lm.server` 时需要,**开发与测试不需要** |

```bash
npm install
```

依赖只有 peerDependencies,作用是让 `lib/*.js` 里的 `@deepseek-ai/*` 导入在本地可解析,并让 `npm test` 能跑。它们与运行时是**同一条版本线**(`^0.1.5-rc.1`),但仍可能与真实 DSH 的具体小版本不同,所以别把 `npm test` 当作运行时兼容性证明——那是 `check:runtime` 的职责,见下文。

若 shell 受限导致 npm 无法写入 `~/.npm`(`EPERM: operation not permitted`),把缓存指到仓库内:

```bash
npm install --cache ./.npm-cache
```

## 基线校验

```bash
npm run check          # node --check,语法
npm test               # node --test,单测
npm run check:runtime  # 与真实 DSH 运行时比对服务端导入与客户端服务(见下)
```

`npm run pack` 只跑 `check` + `test` 再打包;`check:runtime` 依赖本机 DSH 安装,所以不放进 `pack`。

### check:runtime

`scripts/check-runtime.mjs` 做四类检查,都以**真实 DSH 运行时**为准:

1. **服务端具名导入**:扫描 `lib/*.js` 里所有 `@deepseek-ai/*` 的具名导入,逐个到目标运行时的同名包里确认导出存在。这类缺失是 ESM **链接期**错误,插件会直接加载失败。
2. **服务名**:服务端 `export const inject` 与客户端 `const inject` 声明的每个服务,运行时里是否真有插件提供。
3. **服务方法**:`<接收者>.<服务>.<方法>(...)` 里的方法,是否出现在提供该服务的包里。
4. **订阅的事件**:`ctx.on("事件名")` 订阅的事件,运行时里是否确有包发出。

第 2、3 类靠两个来源对齐:从运行时各 bundle 的 `super(ctx, "<名>")` 收集服务清单(服务端扫 `lib/index.js`,客户端扫 `lib/client.js`),再从本仓库代码里抽出服务声明与调用。第 4 类收集 `emit` / `parallel` / `serial` / `bail` / `waterfall` 五种派发的事件名。

扫描前会先剥离注释(状态机实现,不是正则——代码里有 `"http://x"`),否则注释里提到的 API 名字会被当成真实调用。

默认从 `PATH` 上的 `dsh` 反推安装根,也可以显式指定:

```bash
node scripts/check-runtime.mjs                       # 自动定位
node scripts/check-runtime.mjs /path/to/node_modules # 显式指定
DSH_RUNTIME_ROOT=/path/to/node_modules npm run check:runtime
```

**改了 `lib/` 里的导入、服务调用、`inject` 声明或事件订阅之后一定要跑它。** 单测只加载本仓库的 `node_modules`,发现不了版本漂移。

三点局限:

- 方法判据是「方法名在提供该服务的包里出现过」,偏宽松:宁愿漏报也不误报。它抓不住「同一文件里两个服务、方法名恰好撞上」;真要精确追踪得跑起浏览器。
- 只认识通过 `super(ctx, "<名>")` 注册的服务。若某个服务改用别的方式注册,会被当成"无人提供"而**误报**——真遇到时先确认注册方式再判断。
- 事件检查只看**本插件订阅**的事件,不校验回调签名。签名错了(例如 waterfall 少了 `next` 参数)只能靠实测。

### 前向兼容:对第二个运行时跑一遍

`latest` 之外的版本(例如 npm `next` 标签)可以在工作区内单独装一份,不污染开发依赖:

```bash
npm install --prefix .dshtest-rc2 --cache ./.npm-cache @deepseek-ai/dsh@<版本>
node scripts/check-runtime.mjs .dshtest-rc2/node_modules
```

`280MB` 左右,用完删掉即可(`.dshtest*/` 已在 `.gitignore` 中)。0.3.2 就是靠这个确认了对 `0.1.5-rc.2` 同样兼容。

## 开发回路

### 方式一:`--patch` 覆盖层(推荐,不动 profile)

`dsh` 的 `--patch` 会在 profile 层之后叠加一层配置。用**绝对路径**挂载源码入口:

```bash
mkdir -p dev
cat > dev/patch.local.yml <<EOF
- insert:
    - id: dsh-mlx-local-dev
      name: '$(pwd)/lib/index.js'
EOF

dsh --profile web --patch "$(pwd)/dev/patch.local.yml"
```

用绝对路径而不是包名的原因:

- Loader 的 `baseUrl` 是 profile 目录,相对路径会解析到 `~/.dsh/profiles/web/` 下;
- `@deepseek-ai/dsh-client-modules` 的 `locatePkgJson` 对路径型 `name` 会向上找**最近的 `package.json`**,因此服务端入口的宿主包仍是本仓库,`dsh.client` 声明和 `exports["./client"]` 照样生效,设置页那半边也能被扫描到。

`dev/` 已在 `.gitignore` 中。服务端改动(以及 `package.json` 的 `dsh.client` 声明)需要重启 DSH;客户端 bundle 由 `dsh-client-modules` 在启动时重建,一般刷新页面即可。

**已验证可用**(0.3.3 期间实测:从源码挂载、`/mlx/api/status` 正常响应、SIGTERM 优雅退出)。

> ⚠️ **前提:该 profile 的 `bundles` 里不能已经有 `dsh-mlx-local`**。`--patch` 是**追加**一层,若 profile 已经通过 `dsh plugin add` 装过,插件会被挂载两次(两个不同的 entry id → 同一个服务注册两遍),启动会失败或行为异常。开发时二选一:
>
> ```bash
> # 临时把插件从 profile 摘掉,改用 --patch 挂源码
> dsh plugin --profile web remove dsh-mlx-local
> ```
>
> 更省事的做法是配一套隔离 profile(见下节「不碰真实 home 的启动验证」),把 `bundles` 里的 `dsh-mlx-local` 去掉,再用 `--patch` 指向源码。

### 方式二:打包安装

```bash
npm run pack
dsh plugin --profile web add "$(pwd)/dsh-mlx-local-<version>.tgz"
```

`add` 的参数由 `dsh` 转发给 **profile 目录**下的 pnpm,所以传**绝对路径**最稳妥。装完重启 DSH;卸载用 `dsh plugin --profile web remove dsh-mlx-local`。这条路会改 profile 的 bundle 栈,适合验证「用户实际安装后」的行为,**已验证可用**。

### 不碰真实 home 的启动验证

把 `DSH_HOME` 指到工作区内的副本,就能整树启动而不影响 `~/.dsh`,也不需要写 profile:

```bash
mkdir -p .dshtest/profiles/web
cp ~/.dsh/profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml} .dshtest/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules .dshtest/profiles/web/node_modules

DSH_HOME="$(pwd)/.dshtest" dsh --profile web --port 0 --no-open
```

`--port 0` 让系统挑空闲端口,`--no-open` 不弹浏览器。DSH 启动末尾的 `assertEntriesActivated` 会在任一插件条目激活失败时中止启动,所以「起得来」本身就是插件加载通过的证据。要确认插件真的在工作:

```bash
curl -s -X POST "http://127.0.0.1:<端口>/mlx/api/status" -H 'Content-Type: application/json' -d '{}'
```

用完后 kill 进程并删除 `.dshtest/`(`.dshtest/` 已在 `.gitignore` 中)。注意插件的探针日志固定写 `~/.dsh/mlx/logs/`,不受 `DSH_HOME` 影响;写不进去也无妨,`bootLog` 有 try/catch 兜底。

### 验证生命周期行为(卸载/退出清理)

清理逻辑只在卸载时跑,而 `ctx.logger` 默认不写 stdout,光看启动日志看不出它到底有没有执行——0.3.3 那个 `dispose` 死代码就是这么漏掉的。**可靠做法是往文件里写探针**:

```js
// 临时插到待验证的回调里,验完删掉
appendFileSync("/绝对路径/probe.log", `ran at ${new Date().toISOString()}\n`);
```

然后:启动 → 确认关停前文件**不存在**(证明回调没在注册时被误执行)→ `kill -TERM <pid>` → 确认文件**出现**。想要反向对照,就把新旧两种写法各跑一遍。

定位进程:

```bash
pid=$(lsof -nP -iTCP:<端口> -sTCP:LISTEN -t | head -1); kill -TERM "$pid"
```

调试用日志:

- `~/.dsh/mlx/logs/plugin-boot.log` — 插件启动链
- `~/.dsh/mlx/logs/` — `mlx_lm.server` 输出

## 与 DSH 运行时的兼容性

### peerDependencies 的预发布陷阱

这条坑值得记住,因为它会让人**误以为本地一切正常**。插件的 peerDependencies 原本写的是 `^0.1.0-rc.6`,而按 semver 的预发布规则,该范围**只接受 `major.minor.patch` 与之相同的预发布版本**:

| 版本 | 满足 `^0.1.0-rc.6`? |
|---|---|
| `0.1.0-rc.8` | ✅ |
| `0.1.5-rc.1` | ❌ |

于是 `npm install` 会安静地装到 `0.1.0-rc.8`,`npm test` 全绿;而真实 DSH 在模块链接阶段直接抛 `SyntaxError`。这就是 `check:runtime` 存在的理由——它在本机复现了这个差异。

插件现在的范围是 `^0.1.5-rc.1`,能正确匹配 `0.1.5-rc.x`,也能在未来 `0.1.5` 转正后继续匹配到 `<0.2.0`。**改动版本范围时请用 `check:runtime` 复核,不要只看 `npm test`。**

### 已经踩过的缺口

插件原本面向 `0.1.0-rc.6` 一线,在 DSH **0.1.5-rc.1** 上踩了两轮坑:先是服务端**完全无法加载**,修好之后客户端才暴露出第二个问题。**这类漂移的共同点是本地测试全绿**,所以都得靠 `check:runtime` 兜。

**第一轮(0.3.0):服务端具名导入被移除**

| 包 | 缺失导出 | 引用位置 | 0.1.5-rc.1 的替代 |
|---|---|---|---|
| `@deepseek-ai/dsh-llm` | `CallId` | `lib/stream.js` | `ToolCallId`(形状一致,直接改名) |
| `@deepseek-ai/dsh-settings` | `installSettingsSection`、`settingsNamespace` | `lib/index.js` | `ctx.settings.installSection(owner, ns, schema, entry, hooks)`,命名空间写字符串字面量 |

ESM 的具名导入缺失是**链接期**错误,插件直接加载失败。`0.1.5-rc.1` 把注册能力收进了 `SettingsProvider` 实例方法,签名多了一个 `owner`;hooks 契约(`setSource(() => T)` 收 thunk、`onChange`、可选 `validate`)完全不变:

```js
// 旧(0.1.0-rc.x)
installSettingsSection(ctx, NS, Config, config, hooks);

// 新(0.1.5-rc.1)
ctx.inject(["settings"], (sctx) => {
	sctx.settings.installSection(ctx, NS, Config, config, hooks);
});
```

官方插件 `@deepseek-ai/dsh-web-search-deepseek` 就是这么写的,可直接对照。`settingsNamespace` 只是给字符串打类型标记,新 API 用 `SettingsNamespaceInput`(首字母小写 + 连字符)在编译期约束,运行时仍会做同样的合法性检查。

**第二轮(0.3.1):客户端服务改名**

服务端起来之后,设置页点「加载模型…」报 `ctx.workspaces.pickDirectory is not a function`。

坑在于 **`workspaces` 和 `uiWorkspace` 两个服务同时存在**,所以「服务不存在」的直觉判断会落空:

| 服务 | 提供者 | 职责 |
|---|---|---|
| `workspaces` | `@deepseek-ai/dsh-api-workspace-controller` | 数据操作:`create` / `rename` / `delete` / `switch` / `archiveSession` / `insertBefore` |
| `uiWorkspace` | `@deepseek-ai/dsh-client-ui-workspace` | UI 操作:`pickDirectory` / `listDirectory` / `openSession` … |

插件调用的是 `ctx.workspaces.pickDirectory()`,而 `workspaces` 上根本没有 `pickDirectory`,于是运行时才炸。官方目录选择器 `@deepseek-ai/dsh-client-ui-directory-picker-native` 用的正是:

```js
const inject = ["slots", "uiWorkspace"];
// …
const injected = () => ({ pick: () => ctx.uiWorkspace.pickDirectory() });
```

`uiWorkspace.pickDirectory()` 取消时返回 `null`,失败时抛错——与插件「非字符串即未选择」的判断兼容。这一轮也把 `check:runtime` 扩成了客户端检查。

**两轮的共同教训**:`ctx.<服务>` 存在 ≠ 方法存在。对比方法时要看**提供该服务的那个包**,而不是运行时里任何一个包。

**第三轮(0.3.3):事件订阅是死代码**

扩展检查器时,顺带把事件也纳入自动比对,结果立刻抓出一处更隐蔽的问题:插件用 `ctx.on("dispose", …)` 做卸载清理(回收 `mlx_lm.server`、清定时器、摘 `process` 监听)。

但 cordis 4.x **根本不发 `dispose` 事件**。实测枚举它的全部派发,只有这些:

```
internal/config, internal/dispatch, internal/get, internal/listener,
internal/plugin, internal/service, internal/set, internal/status, internal/update
```

运行时里没有任何包发出 `dispose`,也没有任何官方插件订阅它(`agent/disposed`、`session/disposed` 是另外的事件)。所以那个回调**从来没有执行过**——而且不会报错,日志全干净。这就是为什么它值得单独检查:事件改名/消失是**静默失效**,比崩溃难查得多。

cordis 的正确写法是 effect 原语:

```js
// 错:永远不会触发
ctx.on("dispose", () => { /* 清理 */ });

// 对:effect 体立即执行,返回的函数在 fiber 卸载时执行
ctx.effect(() => () => { /* 清理 */ }, "标签(用于 getEffects() 诊断)");
```

官方插件也一律用 `ctx.effect`。此前之所以没暴露,是因为插件还有 `process.once("exit")` 与外部监督脚本两层兜底——但「停用插件/热插拔」这种不退出进程的路径,当时是没人回收模型服务的。

现在版本要求是 `^0.1.5-rc.1`,并且**只支持这一条线**:旧线需要 `CallId` 和模块级 `installSettingsSection`,与新版互斥。

## 设置页栏目排序

`settings.section` 槽按 `order` **升序**排列。官方四个栏目在 `0.1.5-rc.1` 与 `0.1.5-rc.2` 上完全一致:

| order | id | 提供者 |
|---|---|---|
| 0 | `general` | `dsh-client-ui-settings-general` |
| 10 | `models` | `dsh-client-ui-settings-models` |
| 15 | `plugins` | `dsh-client-ui-settings-plugins` |
| 20 | `agent-presets` | `dsh-client-ui-agent-preset` |

**第三方插件应从 30 起排**,让官方栏目始终在最前:`dshmarket` 用 40,本插件用 30——留出间隔是为了避免并列时先后取决于注册顺序。

查当前运行时的实际排序(改 order 前后都值得跑一次):

```bash
node -e '
const fs=require("fs"),path=require("path");
const root="/Users/jianshun/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai";
const rows=[];
for (const pkg of fs.readdirSync(root)) {
  const f=path.join(root,pkg,"lib","client.js");
  if(!fs.existsSync(f)) continue;
  const s=fs.readFileSync(f,"utf8");
  for (const m of s.matchAll(/slots\.register\(\{\s*name:\s*"settings\.section",\s*id:\s*"([^"]+)",\s*order:\s*([0-9.]+)/g)) rows.push([Number(m[2]),m[1],pkg]);
}
rows.sort((a,b)=>a[0]-b[0]);
for (const [o,id,p] of rows) console.log(String(o).padStart(4), id.padEnd(16), p);
'
```

同理,profile 下第三方插件(如 `dshmarket`)的排序可以看它们自己的 `dsh.client` bundle:

```bash
grep -rn "settings\.section" ~/.dsh/profiles/web/node_modules/<插件>/client/ | head
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 服务端入口:插件 `apply`、配置 schema、Python venv 管理(`MlxEnvironment`)、服务生命周期(`MlxServer`)、工具注册、`/mlx/api` 回环接口 |
| `lib/stream.js` | 本地 openai-completions 请求的流式接入:SSE 解析、消息序列化、chunk 翻译为 DSH 的 llm chunk |
| `lib/client.js` | 浏览器端「MLX 模型」设置栏目,手写 React、无构建步骤,遵循 `__ModuleLoader__` 约定 |
| `test/config.test.mjs` | `resolveConfig` 的默认值、校验、Qwen3 思考推断 |
| `test/stream.test.mjs` | SSE 解析、消息序列化、chunk 翻译 |
| `cordis.patch.yml` | bundle patch,安装时把插件挂进 profile |
| `scripts/check-runtime.mjs` | 与真实 DSH 运行时比对服务端导入与客户端服务(本文件「check:runtime」) |
