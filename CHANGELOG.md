# Changelog

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
