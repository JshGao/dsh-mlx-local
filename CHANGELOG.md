# 更新记录

## 0.5.1

修掉 0.5.0 漏改的一处 `settings.get()`——它让**本地模型的推理路径完全失效**,而检查器当时没抓到。

- **`lib/stream.js` 的 `localProviderRoutes` 仍在调用已被删除的 `settings.get()`**(缺陷修复)。这个函数负责算出「哪些 llm-pi-ai 自定义提供方指向本机」,`llm/stream` 拦截器据此决定是否接管请求。`get()` 在 0.1.7 上不存在,抛错后被 `try/catch` 吞掉,于是**路由集永远为空 → 拦截器永远不接管 → 请求落到普通 provider 路径**,用户看到的是:

  ```
  本轮运行失败 No API key for provider: local-mlx
  ```

  也就是说模型能启动、设置页也正常,但**一发请求就失败**。改为 `settings.describe().find((form) => form.ns === "llm-pi-ai")?.value`,与 0.5.0 里 `index.js` 的改法一致。
- **热路径加缓存**(性能)。`describe()` 会遍历全部插件条目并生成表单,而 `llm/stream` 是每个请求都要过的路径。本地路由集合现在缓存 5 秒,本插件自身的配置变化(`loader/volatile-update`)会立刻让它失效;5 秒的上限保证「刚在设置页加好的 provider」在下一次请求即可生效。
- **`check:runtime` 的别名追踪扩展到传递性**(工具增强)。0.5.0 之所以漏掉这一处,是因为 `service` 这个变量并非直接赋值:

  ```js
  settingsService = sctx.settings;                        // 0.5.0 只认这一种
  const service = typeof settingsService === "function"   // ← 经参数/表达式传递
      ? settingsService() : settingsService;
  section = service.get(llmPiAiNs);                       // ← 于是这行没人检查
  ```

  现在别名会迭代到不动点,`service → settings` 能被认出来。回归验证:把 `describe()` 改回 `get()`,检查器立刻报出 `缺失方法 get — 引用位置: stream.js`,退出码 1。传递那一轮刻意保守——只有右值里**调用了**已知别名才算,`x = settingsService.name` 这类属性读取不算,避免把普通变量误判成服务。

## 0.5.0

**破坏性更新:只支持 DSH 0.1.7 及以后。** DSH 0.1.7 重构了设置架构,插件此前依赖的 `settings.installSection` 与 `settings.get` 被整体移除,导致插件在 **0.1.7-rc.2**(当前 `latest`)与 **0.2.0-rc.1**(`next`)上已经**半失效**。本版按新架构重写设置接入。

### 修复:插件在 0.1.7+ 上一直处于半失效状态

`0.1.7-alpha.2` 起 `dsh-settings` 的 `SettingsForms` 只剩 `configure` / `describe` / `update` / `replace` / `mutate` / `schema` / `prepareDocument` 等方法,`installSection` 与 `get` 不复存在。失效链条:

- `ctx.inject(["settings"], …)` 回调里的 `sctx.settings.installSection(...)` 抛 `TypeError`,回调中断;
- 而 `scheduleBoot()`(**启动链的唯一入口**)只在该回调的 `onChange` 里被调用,于是启动链永不执行——接管外部服务、后台端口监控、Qwen3 思考强度补全一起静默停摆;
- 设置页不再出现本插件的任何字段(旧架构靠 `installSection` 注册命名空间);
- `settingsService.get("llm-pi-ai")` 抛错被 `catch` 吞掉,思考强度补全重试 30 次后放弃。

**运行时证据**:`~/.dsh/mlx/logs/plugin-boot.log` 里,9/27 之前每次启动都有 `boot: 启动链执行` / `adopt 完成` / `启动后台端口监控` 三条,之后只剩 `apply: dispose 注册完成` 一条。

### 改造:接入 0.1.7 的设置架构

- **Config 全部字段标 `.volatile()`**。新架构不再由插件注册命名空间,而是扫描每个插件条目的 `Config`、把 volatile 字段当作设置页表单(`dsh-settings` 的 `volatileForm`)。不标的话设置页什么都不显示,`update()` 也会以 "has no volatile fields" 拒绝写入。
- **新增 volatile 解包**。标了 volatile 的字段在 loader 传入的 config 里不再是值,而是 `{ get(), [Symbol.for("cosmokit.volatile.write")](v) }` 引用;直接交给 `resolveConfig` 会把 `port` 当成对象、`models` 当成非数组。新增 `plainConfigValue()` 递归解包。
  - 用 `Symbol.for("cosmokit.volatile.write")` 自行识别,不新增 `cosmokit` 依赖——cosmokit 注册的正是同一个全局 symbol,跨 ESM/CJS 副本也认得出。
  - 配置缓存改为按**序列化结果**判定:loader 更新 volatile 值时是原地写回,config 对象标识始终不变,按标识缓存会一直返回旧配置。
- **写入改用 loader 条目 id**。`settings.update()` 的第一个参数现在是 **profile entry id**,不再是插件自拟的命名空间。改为运行时读取 `ctx.fiber.entry?.options.id`——本插件 `cordis.patch.yml` 里声明的是 `dsh-mlx-local`,与包内旧常量 `mlx-local` 并不一致,硬编码必然写错条目。
- **读取改用 `describe()`**。`settings.get("llm-pi-ai")` 换成 `settings.describe().find((form) => form.ns === "llm-pi-ai")?.value`。
- **移除 `installSection` 调用**。启动链改为 apply 末尾直接调度一次(config 由 loader 同步传入,不再需要等设置层异步合并),此后的配置变更由 `loader/volatile-update` 事件驱动。
- `peerDependencies` 提升到 `^0.1.7-rc.1 || ^0.2.0-rc.1`(两条版本线各自覆盖:预发布 semver 规则下,单一范围无法同时匹配 `0.1.7-rc.x` 与 `0.2.0-rc.1`);`@deepseek-ai/schemastery` 提到 `^3.18.3`——`volatile()` 正是 3.18.3 引入的,在 3.18.2 上会直接抛 `volatile is not a function`。

### 升级必读:模型目录要手工迁移一次

DSH 0.1.7 取消了 `settings.yaml`(设置改存 profile 条目),并自动把旧文件重命名为 `settings.yaml.imported`。但**本插件的配置导入会失败**:旧版 Config 没有 volatile 字段,DSH 在 `volatileForm()` 处抛错跳过,于是模型目录一直留在 `~/.dsh/settings.yaml.imported` 里,没有进入 profile。

升级后请在 profile 的 `cordis.patch.yml` 里补上这一段,再重启 DSH:

```yaml
- id: dsh-mlx-local
  name: dsh-mlx-local
  config:
    models:
      - id: mlx-community-Qwen3-8B-4bit
        repo: /Users/you/Models/mlx-community-Qwen3-8B-4bit/
        name: mlx-community-Qwen3-8B-4bit
```

此后设置页的改动会写回同一个条目,不再需要手工编辑。

### 工具:check:runtime 修掉三处漏检

这次的不兼容**最初是被 `check:runtime` 报成全绿的**,原因是检查器自身有三处缺陷,现已修复:

- **服务注册正则写死了参数名** `super(ctx, …)`,而 0.1.7 的 `dsh-settings` 写的是 `super(ownerContext, "settings")`——整个服务从清单里消失,"消失"的后果不是报错,而是依赖它的检查被静默跳过。
- **`ctx.inject(["settings"], …)` 这类运行时注入未被收集**,只查了顶层 `export const inject`。
- **别名调用漏检**:`settingsService = sctx.settings` 之后的两段式调用 `settingsService.get(...)` 抽取不到,新增别名追踪。

方法存在性的判据也从 `includes("get(")` 收紧为「方法名前面不是点」——旧判据会被 `revisions.get(` 这类 Map 调用误判为"存在",这正是 `get` 被漏掉的原因。两个新版本上现在都能准确报出:

```
✗ settings (dsh-settings)
    缺失方法 get — 引用位置: index.js
    缺失方法 installSection — 引用位置: index.js
```

## 0.4.2

本版是针对 DSH **0.1.6-alpha.2**(npm `alpha` 标签)的兼容性复核:插件在该版本上**可以正常加载**,API 接触点无一处失效。复核同时暴露并修掉了一个一直存在、却因静默跳过而从未报错的客户端注入缺陷。

- **修正 `dsh.client.inject` 的模块名**(缺陷修复)。第三个依赖原本写的是 `@deepseek-ai/dsh-client-ui-slots`,但该包**不在客户端模块图内**——它只出现在官方包的 `devDependencies` 里,自身没有 `dsh.client` 声明,host 不会把它编进图。浏览器端对图里没有的名字是**静默跳过**(`if (dependency !== void 0)`),所以这个注入从写下那天起就没生效过,也从不报错。
  - 改为 `@deepseek-ai/dsh-client-ui-renderer`,即 `slots` 服务的真正提供者,与官方惯例一致(需要 slots 能力的官方包如 `dsh-client-ui-chat` / `-locale` / `-resources` 都是这么 inject 的)。
  - 实际影响有限:加载顺序此前靠 `dsh-client-ui-workspace` → `renderer` 的传递注入链,以及 cordis 的服务注入(`inject = ["slots", "uiWorkspace"]`)兜住,「MLX 模型」栏目一直能正常显示。这次修的是**显式保证**,不是可见故障。
  - 列表改为字母序,与官方包写法一致。
- **`check:runtime` 从四类检查扩展到六类**(工具增强)。新增两类此前完全无覆盖的漂移,二者都是"改名不报错、只是静默失效":
  - **界面槽**:比对 `ctx.slots.inject("槽名", …)` 的槽名是否还有别的包在用。槽没有中心注册表,官方包各自领用,"有没有别人用这个名字"是槽是否存在的唯一判据。槽名若改,设置页整个栏目消失,而控制台一行错都不报。
  - **客户端模块图**:比对 `package.json` 的 `dsh.client.inject` 里每个包名是否真的在图内(包存在**且**自带 `dsh.client` 声明)。上面那个 `dsh-client-ui-slots` 缺陷正是被这条新检查抓出来的;写完立刻用它做了回归——确认能报错(退出码 1),而不是一条永远通过的检查。
- **0.1.6-alpha.2 逐项核对结果**(六类检查在 `0.1.6-alpha.2` 全量树与 `0.1.5-rc.2` 上**全部通过**):
  - 具名导入不止静态存在,还在新运行时上**真实 import 链接成功**:`dsh-llm` 的 `EMPTY_RESPONSE_CODE` / `LlmError` / `ToolCallId` / `attributionHeaders` / `contentHasImage`,`dsh-timeout` 的 `MAX_TIMER_DELAY_MS` / `idleWatchdog` / `timeoutOf`。该版 `dsh-llm` 移除了 `offloadedImagePrefixCount` / `offloadRequestImagesWithPolicy`、新增 `IMAGE_OFFLOAD_REQUIRED_CODE` / `projectOffloadedImages` / `requiredImageOffload`,插件均未使用。
  - `llm/stream` 仍是 waterfall `(options, next)`,派发点未变;`settings.installSection(owner, ns, schema, entry, hooks)` 签名一字未改;`webServer.register` 所在的 `dsh-host-webserver` 两版**逐字节相同**。
  - 客户端 `slots._register` 实现逐行一致(新版只是多了个 `_registerFactory`);`__ModuleLoader__.load({id, factory})` 外部契约未变(内部存储由 `factory` 改为 `{factory, rev}`,对插件透明)。
  - 槽 `settings.section` 仍在;官方栏目 order 最大值由 20 变为 25(新增 `dsh-client-ui-settings-unarchive-sessions`),插件的 `order: 30` 依旧排在最后,无并列。
  - 客户端 bundle 按约定**真实求值**通过(注入假 `window.__ModuleLoader__` 并实际调用 factory);`apply(ctx)` 在真实 cordis Context 上挂载冒烟通过。
- **peerDependencies 范围保持不变**(`^0.1.5-rc.1`)。它在 semver 上**不匹配** `0.1.6-alpha.2`,装 alpha 时 npm 会报 `ERESOLVE`——但这是**整个 DSH 生态的普遍现象**:官方包同样写 `^0.1.5-rc.2`,一样不匹配,属于预发布规则的固有行为,转正后的 `0.1.6` 会自动匹配。且 DSH 加载插件时只用 peer 的**包名**建模块解析回退图(`dsh-app-boot` 的 `profileDependencyNames` 取 `dependencies` + `peerDependencies` 的键),**不校验版本范围**,所以不影响运行。alpha 阶段的 `ERESOLVE` 用 `--legacy-peer-deps` 绕过即可。
- 附注:`0.1.6-alpha.2` 自身是**混合版本树**——它的依赖写 `^0.1.5-rc.2`,导致多数子包仍解析到 `0.1.5-rc.2`。混合树与强制全量 0.1.6-alpha.2 两种组合都验过,均通过。

## 0.4.1

本版把插件**收回"基础设施"定位**:它只负责把本地模型跑起来,**不注册系统提示词段,也不注册任何工具**。装了这个插件,任何会话都不会因此多付一个 token。

- **移除全部 `mlx_*` 工具**(破坏性变更)。0.4.0 的 10 个工具(`mlx_status` / `mlx_list_models` / `mlx_add_model` / `mlx_remove_model` / `mlx_pull_model` / `mlx_setup` / `mlx_start` / `mlx_stop` / `mlx_switch_model` / `mlx_chat`)整体删除,插件不再向任何 agent 暴露工具。
  - 理由:本地模型的**推理侧接入**已经由 DSH 自定义提供方 + 本插件的 `llm/stream` 拦截器完成,而**服务与模型目录的管理**是用户自己的运维动作,不需要智能体在对话里代劳。
  - 工具 schema 是每个模型步骤、每个 agent 的每次请求都重发的固定成本(10 个工具实测 2866 字符 / 约 956–1448 token/请求)。删除后这部分成本归零。
  - `inject` 由 `["tools", "llm"]` 收敛为 `["llm"]`;`peerDependencies` 移除 `@deepseek-ai/dsh-tools`。插件不再依赖 `tools` 服务,该服务缺失时也能正常加载。
  - 原本由工具完成的全部操作仍然可用:设置页「MLX 模型」可以启动/停止/切换服务、添加/移除/预下载模型、查看状态与日志。
  - 插件内所有错误提示与 guidance 不再指向工具名,统一改为指向设置页操作;`stream.js` 的「服务未运行 / 模型不一致」错误同样改为引导到设置页。
  - 开发期短暂存在过的 `enableTools` 开关随工具一起下线;旧设置里若残留该字段,会被 `resolveConfig` 静默丢弃,不需要手动改 `settings.yaml`(已有测试覆盖)。
- **移除系统提示词注入**(行为变更)。此前 `apply` 会在全局作用域注册一个 `tool:mlx-local` 提示词段(设置页接入指引 + 工具名清单 + 8080 端口说明)。全局段对**所有 agent、每个模型步骤的每次请求**都会重发(`dsh-system-prompt` 把它渲染成派生历史里的 system 角色消息),因此与 MLX 完全无关的会话也会带上它,固定成本约 413 字符 / 180–220 token。
  - 内容本身就不该给模型看:「设置 → 模型 → 添加 provider」是面向用户的界面操作指引,模型无法也无需执行;`127.0.0.1:8080` 还是硬编码,用户改 `port` 后会与实际不符。
  - 删除了 `SYSTEM_PROMPT` 常量与 `ctx.systemPrompt.section(...)` 调用,`inject` 同步去掉 `systemPrompt`——插件不再依赖该系统提示词服务。

## 0.4.0

- **移除「随 DSH 启动自动拉起服务」功能**(破坏性变更)。服务不再随 DSH 启动,每次都必须显式启动:设置页的「启动」按钮,或 `mlx_start` 工具。相应地删掉了配置项 `autoStart`、设置页上的开关、以及启动链里的自动拉起分支;`setConfig` 接口传入 `autoStart` 现在会报「不支持的设置项」。
  - 旧 `settings.yaml` 里残留的 `autoStart` 不会导致校验失败(schemastery 不剥离未知键),由 `resolveConfig` 丢弃,已有测试覆盖。
  - 启动链保留:仍会在设置加载完成后**接管已在运行的外部服务**(adopt)并启动后台端口监控,只是不再主动拉起。
  - 错误提示「本地 MLX 服务未运行」不再指向已不存在的开关。

## 0.3.3

- 修复卸载清理从不执行的问题:`ctx.on("dispose", …)` 是死代码——cordis 4.x 只派发 `internal/*` 事件,**没有 `dispose` 事件**,运行时里无人发出、官方插件也无人订阅,回调永远不会触发。改用 cordis 的 effect 原语 `ctx.effect(() => () => { … })`:effect 体立即执行,其返回的函数在 fiber 卸载时执行。影响:此前停用插件或热插拔时不会主动回收 `mlx_lm.server`,只能靠 `process.once("exit")` 与监督脚本兜底。
- `npm run check:runtime` 增加事件检查:插件 `ctx.on("事件名")` 订阅的事件必须在目标运行时中确有包发出。事件改名不会报错、只会静默失效,所以必须单独查。
- 检查器改为先剥离注释再扫描,避免文档里出现的 API 名字被误判为真实调用。

## 0.3.2

- 设置页「MLX 模型」栏目从 `order: 12` 调到 `order: 30`,排到官方四个栏目之后。官方占 0/10/15/20(通用设置/模型/插件/智能体预设),原来的 12 正好卡在「模型」和「插件」之间;第三方插件用 30 起(dshmarket 用 40)。
- `npm run check:runtime` 扩展到覆盖服务名与服务方法,不再只看具名导入。现在会校验:服务端 `inject` 声明的 `tools` / `llm` / `systemPrompt` 是否有插件提供;`ctx.tools.register`、`ctx.systemPrompt.section`、`sctx.webServer.register`、`sctx.settings.installSection` / `update`、`ctx.slots.inject` / `register`、`ctx.uiWorkspace.pickDirectory` 这些方法在提供该服务的包里是否真的存在。
- 针对 **0.1.5-rc.2**(npm `next` 标签)复核通过:具名导入、服务名、服务方法、`settings.section` 排序全部一致。

## 0.3.1

- 修复设置页「加载模型…」报 `ctx.workspaces.pickDirectory is not a function`。客户端目录选择能力在 `uiWorkspace` 服务(`@deepseek-ai/dsh-client-ui-workspace`)上,而不是 `workspaces`——后者由 `@deepseek-ai/dsh-api-workspace-controller` 提供,只有 create/rename/switch 等数据操作,所以服务存在但方法不存在。官方目录选择器 `@deepseek-ai/dsh-client-ui-directory-picker-native` 用的也是 `inject = ["slots", "uiWorkspace"]` + `ctx.uiWorkspace.pickDirectory()`。
- `npm run check:runtime` 扩展为同时校验客户端半边:比对 `lib/client.js` 声明的注入服务与调用的方法在目标 DSH 中是否存在。同类问题以后会在本地暴露。

## 0.3.0

- 适配 DSH 0.1.5-rc.1:插件此前在该版本上**无法加载**,因为三个具名导入已被移除。
  - `CallId` → `ToolCallId`(`@deepseek-ai/dsh-llm`);
  - 模块级 `installSettingsSection` / `settingsNamespace` → `ctx.settings.installSection` 实例方法与字面量命名空间。
- `peerDependencies` 由 `^0.1.0-rc.6` 提升到 `^0.1.5-rc.1`。旧范围按 semver 的预发布规则并不匹配 `0.1.5-rc.1`,会让人误装到 `0.1.0-rc.x` 而看不出版本漂移。
- 移除 `dsh.client.inject` 中已不存在的 `@deepseek-ai/dsh-client-runtime`。
- 新增 `npm run check:runtime`,把 `lib/*.js` 的具名导入与真实 DSH 运行时逐个比对。
- 新增 [DEVELOPMENT.md](DEVELOPMENT.md):环境准备、开发回路与兼容性说明。

## 0.2.3

- 修复设置页不显示“MLX 模型”的问题:客户端依赖显式加入 settings 与 workspace 模块。

## 0.2.2

- 只使用 DSH 自定义提供方,不再注册额外 provider。
- 自动为本地 Qwen3 补全思考强度配置,模型选择器显示 Off / High。
- 本地 openai-completions 请求直接流式接入 `mlx_lm.server`,思考强度实时生效。
- 服务进程随 DSH 退出、插件停止、插件卸载自动关闭;即使 DSH 被强杀,监督进程也会清理本地模型服务。
- 设置页支持启动、停止、切换模型、参数设置、日志查看和残留进程回收。
