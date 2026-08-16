# Changelog

## 0.2.2

- 完全移除内置 `mlx-local` provider 与设置页 provider 选项;DSH 模型选择器只使用你已有的自定义提供方。
- 新增 `llm/stream` 拦截器(`lib/stream.js`):不注册任何 provider,但拦截指向本地 MLX 服务的 openai-completions 请求,把主界面选择的思考强度正确翻译为 `chat_template_kwargs`。
- 自动升级 `llm-pi-ai` 中指向本地 MLX 服务的 Qwen3 模型配置(`reasoningEfforts` + `thinkingFormat: qwen`),因此主界面对话框选择模型时会像其他思考模型一样显示 **Off / High**。
- 移除设置页“所选模型开启思考(Qwen3)”复选框;服务级 `thinkMode` 仍保留为默认值。
- 服务启动改为外部监督进程:即使 DSH 被强杀(SIGKILL),监督脚本也会检测父进程消失并杀死 python,彻底消除孤儿进程。
- 热插拔/停用插件/DSH 正常退出时,继续通过 dispose 同步清理服务进程组。

## 0.2.1

- 内置 `mlx-local` provider 改为**默认关闭**(`registerProvider: false`):日常使用自定义提供方即可,不会在模型菜单里多出 provider;需要时在设置页勾选开启。
- Qwen3 思考开关:
  - 旧设置中 `mlx-community-Qwen3-8B-4bit` 条目自动推断 `thinking: true`;
  - 设置页可为所选模型勾选“开启思考(Qwen3)”,保存到模型目录;
  - 开启 `registerProvider` 后,模型选择器为 Qwen3 显示“开启思考/关闭思考”,并通过请求级 `chat_template_kwargs` 即时生效;
  - 服务级 `thinkMode: auto` 现在按模型 `thinking` 字段生成 `--chat-template-args`。
- 退出清理强化:
  - `mlx_lm.server` 以独立进程组启动;
  - DSH `dispose` 同步 SIGTERM 进程组 + detached 脚本兜底;
  - `process.exit` 前同步 SIGKILL 进程组,彻底避免孤儿进程。
- 修复 `/mlx/api/setConfig` 同时保存 `models` 与 `defaultModel` 时对新模型 id 的校验。

## 0.2.0

- 新增内置 LLM 提供者 `mlx-local`(`lib/llm.js`):
  - 把 harness 消息序列化为 OpenAI chat/completions 请求;
  - 解析 mlx_lm.server SSE(keepalive/CRLF/任意分块),翻译 text/reasoning/tool_calls/usage 为 DSH `StreamChunk`;
  - `serveOnDemand`(默认开启)在推理前按需启动或切换本地服务。
- `MlxServer` 增强:
  - 记录服务实际监听的 host/port/参数,配置变更后再次启动才会切换;
  - 同一模型+同参数启动幂等,不同模型/端口/参数会自动重启;
  - `stop()` 并发安全;spawn error 不再挂死启动状态;
  - 新增 `recoverPort()` 与设置页"回收残留服务"按钮;
  - 本地路径模型比较忽略末尾 `/` 差异(正确接管设置中带尾斜杠的路径)。
- 设置页新增 `serveOnDemand` 开关;`mlx-local` 提供者接入说明写入系统提示词与 README。
- 动态沙箱模板(`dsh-mlx-local.dyn.js`):
  - 配置文件路径与默认本地模型目录改为运行时从 `$HOME` 推导,不再硬编码用户目录;
  - `mlx_load` 校验完整 MLX 权重;
  - 新增 `recover` host handler 与客户端残留回收按钮。
- 工程化:
  - `lib/llm.js` 从 `lib/index.js` 中拆出;
  - 新增 `npm run check` / `npm test` / `npm pack`;
  - 新增 `test/llm.test.mjs` 与 `test/dyn.test.mjs`。
