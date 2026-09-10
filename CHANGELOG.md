# 更新记录

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
