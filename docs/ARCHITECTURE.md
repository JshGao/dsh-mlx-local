# 架构说明

## 总体结构

```
┌─────────────────────────── DSH (node, web profile) ───────────────────────────┐
│                                                                                │
│  dsh-mlx-local 插件 (lib/index.js + lib/stream.js + lib/client.js)            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐          │
│  │ llm/stream   │  │  mlx_* 工具  │  │ MlxServer (子进程管理器)      │          │
│  │ 拦截器        │  │ (defineTool) │  │  ├─ 状态机 stopped/starting/  │          │
│  │ 本地自定义路由│  │  10 个工具    │  │  │   running/stopping        │          │
│  └──────┬───────┘  └──────┬───────┘  │  ├─ 就绪轮询 /health          │          │
│         │  ctx.llm        │ ctx.tools │  ├─ 监督进程:父 pid 消失即杀  │          │
│         └──────┬──────────┴───────────┘  └────────────┬──────────────┘          │
│                │                                      │ spawn sh 监督进程        │
│  installSettingsSection ──► ctx.settings (mlx-local 命名空间)                   │
└────────────────────────────────────────────┬────────────────────────────────────┘
                                             │
                                             ▼
                    ┌─────────────────────────────────────┐
                    │ Python venv (~/.dsh/mlx/venv)       │
                    │  └─ python -m mlx_lm.server          │
                    │       --model <repo|path>            │
                    │       --host 127.0.0.1 --port 8080   │
                    │  OpenAI 兼容 API (/v1/chat/completions│
                    │  /v1/models /health,SSE 流式)         │
                    └─────────────────────────────────────┘
```

两条"接入"通道:

1. **LLM 请求拦截通道(不注册 provider)**:插件监听 `llm/stream`,当请求的 provider 是 `llm-pi-ai` 中指向 `127.0.0.1`/`localhost` 的 openai-completions 自定义路由时,直接由本插件把 harness 会话序列化为 OpenAI chat/completions 请求发给本地服务,并把 SSE 流翻译回 harness 的 `StreamChunk` 协议;其他 provider 原样走 `next()`。模型选择器仍由 `llm-pi-ai` 负责,插件只自动补齐 Qwen3 的 `reasoningEfforts`,因此主界面可选 Off/High 思考强度。
2. **工具通道(智能体控制服务)**:`mlx_*` 工具经 `ctx.tools.register` 注册,智能体在对话中即可启动/停止/切换/增删/预下载模型、发起一次性对话。

## 进程与状态模型

- **插件进程**(node,随 DSH 生命周期):管理状态机与子进程;DSH 退出时 `dispose` 钩子优雅停止服务。
- **服务进程**(venv python,`mlx_lm.server`):单进程单模型,以独立进程组启动,监听 `127.0.0.1:<port>`;DSH 退出时整组终止。
- 状态迁移:`stopped → starting → running`,`running → stopping → stopped`;崩溃(exit 事件且非 stopping)自动回到 `stopped` 并记录 `exitInfo` 与最近日志。
- 就绪判定:启动后每 500ms 探测 `GET /health`;`startTimeoutMs` 内未就绪不杀进程,改由后台定时器持续探测并在就绪时提升状态(覆盖首次下载权重耗时较长的情况)。
- 并发安全:`start()` 通过 `startPromise` 守卫,并发调用共享同一启动任务;`stop()` 幂等。

## Python 环境策略

1. **始终使用自有 venv**(`venvDir`,默认 `~/.dsh/mlx/venv`),不在系统环境安装任何包。
2. `ensure()` 流程:
   - venv 存在且可导入 `mlx_lm` → `ready`,直接使用;
   - 否则探测基础 Python(优先级:配置 `pythonBin` → PATH 与 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 下的 `python3.13…python3`,以及 `/usr/bin/python3`);
   - 版本判定:接受 3.9–3.13,优先 3.10–3.12(更高版本排序在前);3.9 可用但记录警告;低于 3.9 视为不可用;
   - 选中基础 Python 后 `python -m venv` 创建 venv,`venv/bin/pip install --upgrade mlx-lm`,最后导入验证并读取版本;
   - **找不到合适 Python 时不静默失败**:返回 `missing-python` 状态,附 `brew install python@3.12` 等安装引导,`mlx_setup` 与所有依赖环境的工具都会呈现该引导。
3. 所有探测均为只读子进程调用(`--version` / `import` 检查),`mlx_status` 的 `environment.inspect()` 不触发任何安装。

## 适配器数据流

```
harness 消息 ──► serializeMessages ──► OpenAI 消息数组
                                       (system/assistant+tool_calls/tool 结果独立消息)
                                       请求体:stream:true, stream_options.include_usage,
                                       tools(若有),temperature/max_tokens/stop
                                       (不发送 model:mlx_lm.server 以 --model 为准,
                                        且 0.31.x 会尝试解析未知 model 仓库)
                                                 │  POST {baseURL}/v1/chat/completions
                                                 ▼
                                        mlx_lm.server SSE 流
                                                 │  parseSse(自实现,容忍任意分块/CRLF/
                                                 │    keepalive,[DONE] 缺失则 STREAM_CLOSED)
                                                 ▼
                                        translate(载荷 → StreamChunk)
                                        delta.content → text 块
                                        delta.reasoning → reasoning 块(Qwen3 思考)
                                        delta.tool_calls → tool-call 块(按 index 累积;
                                          mlx-lm 0.31.x 每个调用一次给全 arguments)
                                        finish_reason: stop/tool_calls/length
                                        usage: prompt_tokens 减去 cached_tokens 得到
                                          harness 的不相交 inputTokens
                                                 │
                                                 ▼
                                        harness StreamChunk 协议
```

- 服务未运行 → `LlmError(SERVER_OFFLINE)`;模型不一致 → `SERVER_MODEL_MISMATCH`。
- 空闲看门狗 → `TIMEOUT`;调用方中止 → `ABORTED`;HTTP 错误映射 400→`INVALID_REQUEST`、429→`RATE_LIMIT`、5xx→`SERVER`。
- 请求带 `attributionHeaders()`(dsh-llm 契约要求),不发 API key(本地服务无需鉴权)。

## 设置与热更新

- 配置 Schema(`Config`)即设置命名空间 `mlx-local` 的 Schema;`installSettingsSection` 把 loader entry 作为 base 层,`scope.get()` 作为实时来源。
- 每次请求/启动都通过 thunk 读取最新配置:改模型目录、端口、超时无需重启插件。
- `mlx_add_model` / `mlx_remove_model` 通过 `ctx.settings.update(NS, { models })` 持久化到设置用户层;设置服务不可用时返回明确错误。
- 配置校验失败时保留最后有效配置(惰性解析,与 `dsh-llm-deepseek` 同款模式)。

## 源码布局

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 配置 Schema、日志环、Python venv 管理、`MlxServer` 状态机、`mlx_*` 工具、`/mlx/api`、生命周期装配 |
| `lib/stream.js` | 本地 openai-completions 请求拦截:消息序列化、SSE 解析、`StreamChunk` 翻译、`reasoningEffort → chat_template_kwargs` |
| `lib/client.js` | Web 设置页 "MLX 模型" 栏目(手写 React,bundle 格式) |
| `dsh-mlx-local.dyn.js` | 动态沙箱版模板(`HOST_CODE` / `CLIENT_CODE`,控制工具子集) |
| `test/stream.test.mjs` | 消息序列化、SSE 解析、流翻译的纯函数单元测试 |

## 生命周期

| 事件 | 行为 |
|---|---|
| 插件加载 | 注册工具、系统提示片段、llm/stream 本地拦截器;若 `autoStart` 且目录非空则延迟启动 defaultModel/首个模型 |
| 设置变更 | 模型目录等即时生效;端口/参数变更在下一次启动时采用(运行中的实例保留自己的实际监听值) |
| 服务崩溃 | 状态回到 `stopped`,`exitInfo` + 最近日志可查 |
| 端口占用 | 启动前探测 `/health`;健康服务占用则报错;无响应的 Python 残留进程自动回收后重试 |
| DSH 退出 / 插件停用 / 热插拔 | `dispose` 同步 SIGTERM 服务进程组并派发 detached 清理脚本;`process.exit` 时同步 SIGKILL;即使 DSH 被强杀,监督进程也会在父 pid 消失后杀死 python |
| 模型切换 | `mlx_switch_model` = stop + start;切换期间在途流式请求中断并按 ABORTED/STREAM_CLOSED 报错,上层可重试 |

## 安全边界

- 服务仅监听 `127.0.0.1`(可配置 host,默认本机回环),不对外网暴露。
- 不向本地服务发送任何密钥;不修改系统 Python 环境。
- 仅回收本插件端口上的无响应 **Python** 进程(残留回收按钮/启动前自动回收),不杀健康服务或其他程序。
- 子进程输出仅写 `~/.dsh/mlx/logs/server.log`(含模型下载进度,无敏感内容)。
