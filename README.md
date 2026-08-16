# dsh-mlx-local

在 Apple Silicon 上用 [MLX](https://github.com/ml-explore/mlx) 框架运行本地大模型的 DeepSeek Harness 插件。

- **加载不同的模型** — 维护一个模型目录(HF 仓库或本地路径),随时 `mlx_switch_model` 切换服务加载的模型
- **开启/停止服务** — 以子进程管理 `mlx_lm.server`(OpenAI 兼容 API),启动、停止、状态、崩溃检测、残留进程回收一应俱全
- **注册为 DSH 自身的 LLM 提供者** — 路由名 `mlx-local`:在模型选择器里直接选本地模型,发起推理时按需启动/切换本地服务,流式输出、思考块、工具调用全部翻译成 DSH 协议
- **也提供 `mlx_*` 工具** — 让智能体在对话中直接控制本地服务,并保留手工"添加 OpenAI 兼容 provider"的接入方式
- **自带 Python 环境** — 插件运行在自有 venv 中;探测宿主机上版本合适的 Python(3.9–3.13,优先 3.10–3.12)创建虚拟环境并安装 `mlx-lm`;找不到合适 Python 时给出安装引导

## 环境要求

| 项目 | 要求 |
|---|---|
| 硬件 | Apple Silicon(M 系列)Mac |
| 系统 | macOS 13+ |
| Python | 3.9–3.13(建议 3.10–3.12);未安装时插件会给出 `brew install python@3.12` 引导 |
| 磁盘 | 每个 4-bit 模型约 2–6 GB(HF 下载缓存于 `~/.cache/huggingface`) |
| 网络 | 首次启动需从 HuggingFace 下载模型权重(可用 `mlx_pull_model` 预下载) |

## 安装

本仓库同时提供两种安装形态;两者共享 `~/.dsh/mlx/` 下的 venv 与日志,配置存储位置不同。**同一时间只启用一种**,避免重复注册 `mlx_*` 工具。

### 方式 A:标准 npm 插件(功能完整)

标准插件包含内置 LLM 提供者、完整 `mlx_*` 工具、设置页栏目与 `/mlx/api`:

```bash
dsh plugin --profile web add /Users/jianshun/Documents/DeepSeekHarness/dsh-mlx-local
# 或安装发布包:
dsh plugin --profile web add dsh-mlx-local-0.2.0.tgz
```

配置写入 DSH 设置命名空间 `mlx-local`(`~/.dsh/settings.yaml`),重启 DSH 后仍生效。

### 方式 B:动态插件(完全热插拔)

`dsh-mlx-local.dyn.js` 导出的 `HOST_CODE` / `CLIENT_CODE` 是动态沙箱版模板:更新插件**无需重启 DSH**(对话中 define + run 即可)。动态版在沙箱内没有 `fetch`/Node 子进程 API,因此**不包含内置 LLM 提供者**,只提供服务控制工具与精简设置面板;需要内置 provider 时请使用方式 A。

Web profile 已内置动态插件所需的 `shell` 服务,无需修改 `cordis.patch.yml`。

> **不要**额外挂载 `@deepseek-ai/dsh-bash-local`:它会与内置的 `bash-sandbox`
> 重复注册 `shell` 服务,导致 DSH 在加载插件树时启动失败。

**激活(动态版)**(对话中让模型执行,模板代码见 `dsh-mlx-local.dyn.js` 的 `HOST_CODE` / `CLIENT_CODE`):
```
cordis_define(plugin: {kind:"new", idPrefix:"mlx"}, code.host: <HOST_CODE>, code.client: <CLIENT_CODE>)
cordis_run(mode: "new")
```

**更新**(无需重启 DSH):
```
cordis_define(plugin: {kind:"existing", pluginId:<pluginId>}, code.host: <新HOST_CODE>, code.client: <新CLIENT_CODE>)
cordis_run(mode: "update")
```

**DSH 重启后**:动态插件不持久,重复"激活"步骤即可(配置保存在 `~/.dsh/mlx/config.json` 自动继承;若残留模型服务进程,激活时自动接管)。

## 快速开始

安装/激活插件后,新会话中智能体即可使用 `mlx_*` 工具。典型流程:

1. **查看状态**(一切从这里开始)
   `mlx_status` — 服务状态、当前模型、最近日志、Python 环境。

2. **启动服务**
   `mlx_start` — 默认加载目录中第一个模型(或 `defaultModel`)。就绪后状态自动变为 `running`。

3. **让 DSH 跑在本地模型上**
   - **推荐(默认)**:继续使用你已经配置的“自定义提供方” `local`(openai-completions → `http://127.0.0.1:8080/v1`,API Key 任意值);
   - 插件默认**不注册** `mlx-local` 路由,避免模型菜单里多出容易混淆的 provider;
   - 若确实希望模型选择器里出现 **MLX Local**:在 设置 → MLX 模型 中勾选 `registerProvider` 并保存,新会话/刷新后即可选择;此时 `serveOnDemand`(默认开启)会在推理前自动启动/切换服务,且 Qwen3 会显示“开启思考/关闭思考”开关;
   - 流式输出、思考块(`reasoning`)与工具调用均可用,推荐 Qwen3。

4. **切换模型 / 停止服务**
   `mlx_switch_model` 切到另一个模型(会先停后启);`mlx_stop` 停止服务。

## 工具一览

| 工具 | 说明 |
|---|---|
| `mlx_status` | 服务状态、当前模型、pid、端口、最近日志、Python 环境 |
| `mlx_setup` | 初始化 venv 并安装/验证 mlx-lm(找不到 Python 时给引导) |
| `mlx_start` | 启动服务(可指定模型 id 或本地路径,可覆盖端口/附加参数) |
| `mlx_stop` | 停止服务(优雅停止,超时强杀) |
| `mlx_switch_model` | 切换到指定模型(停旧启新) |
| `mlx_list_models` | 模型目录 + 当前活跃模型 + 权重可用性 |
| `mlx_add_model` | 向模型目录添加模型(持久化到设置) |
| `mlx_remove_model` | 从模型目录移除模型 |
| `mlx_pull_model` | 预下载 HF 模型权重到本地缓存 |
| `mlx_chat` | 对运行中的服务发一次非流式对话,快速验证 |

> `dsh-mlx-local.dyn.js` 中的动态沙箱版提供上述工具的子集(`mlx_status/start/stop/switch_model/list_models/load/chat`),配置文件为 `~/.dsh/mlx/config.json`;标准 npm 包版本提供完整工具,配置写入 DSH 设置命名空间 `mlx-local`。

## 配置

标准插件配置保存在 **设置命名空间 `mlx-local`**(Settings → MLX 模型 栏目可编辑):

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 服务监听地址(仅本机) |
| `port` | `8080` | 服务端口 |
| `defaultModel` | `""` | 自动启动/默认加载的模型 id;为空时取目录第一个 |
| `autoStart` | `false` | DSH 启动/插件热载入时自动拉起服务 |
| `serveOnDemand` | `true` | 仅当注册了 `mlx-local` 路由时生效:发起推理自动启动/切换服务 |
| `registerProvider` | `false` | 是否在 DSH 模型选择器中注册 `mlx-local` 路由;关闭时使用自定义提供方 |
| `thinkMode` | `auto` | 服务级思考模式:auto/on/off;auto 时按各模型 `thinking` 字段决定(Qwen3 自动开启) |
| `serverArgs` | `[]` | 附加启动参数 |
| `streamIdleTimeoutMs` | `300000` | LLM provider 流式读取空闲超时 |
| `venvPython` | 自动探测/创建 | `~/.dsh/mlx/venv/bin/python`(Python 3.9–3.13 + mlx-lm) |
| `models` | 内置 3 个 HF 模型 | 模型目录;每项可设置 `thinking`(是否开启思考);当前机器设置中已保存为 `~/Documents/LLM Model/` 下的本地模型 |

内置默认模型目录(HF 仓库;本机若已保存设置,则以设置中的本地路径为准):

| id | repo | 说明 |
|---|---|---|
| `qwen3-8b` | `mlx-community/Qwen3-8B-4bit` | 支持函数调用与思维链,~4.3 GB |
| `qwen2.5-7b` | `mlx-community/Qwen2.5-7B-Instruct-4bit` | 中文能力强,~4.5 GB |
| `llama-3.2-3b` | `mlx-community/Llama-3.2-3B-Instruct-4bit` | 轻量,~1.7 GB |

> 可通过 `mlx_load` / 设置页"加载模型…"加入任意本地 MLX 模型目录;设置文件(`~/.dsh/settings.yaml`)也可手工编辑。

## API 接入说明

服务即 OpenAI 兼容 API(由 `mlx_lm.server` 提供),仅监听 `127.0.0.1`:

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 对话(流式 SSE / 非流式均可,支持 `tools`) |
| `GET /v1/models` | 模型列表(服务当前加载的模型) |
| `GET /health` | 健康检查 |

### 兼容协议

本地模型兼容 **OpenAI chat/completions 协议**(流式 + 工具调用),即 DSH 自定义提供方中的 **`openai-completions`** 协议。

### 接入方式一:自定义提供方(默认/推荐)

在 **设置 → 模型 → 添加 provider** 中:

1. 选择 **自定义提供方**;
2. route 名:任意(如 `local`);
3. 协议:**`openai-completions`**;
4. baseURL:`http://127.0.0.1:8080/v1`(设置 → MLX 模型 栏目中展示,可一键复制);
5. 模型 id:任意(如 `local`),实际由服务当前加载的模型应答,API Key 填任意值。

### 接入方式二:内置 `mlx-local` 提供者(可选)

插件默认不注册该路由。若在 设置 → MLX 模型 中开启 `registerProvider`,模型选择器会出现 **MLX Local**,且 Qwen3 提供“开启思考/关闭思考”开关。发起推理时适配器会:

1. 若服务未运行且 `serveOnDemand=true` → 自动 `mlx_start`;
2. 若当前加载模型与所选模型不一致 → 自动 `mlx_switch_model`;
3. 把 harness 消息、tools、system prompt 序列化为 OpenAI 请求,并把 SSE 流翻译回 DSH 的 `StreamChunk` 协议。

> 思考控制有两个层级:设置页“思考模式”是服务启动默认值;模型选择器里的开关通过 `chat_template_kwargs` 每次请求生效,无需重启服务。

## 设置页栏目(Web UI)

插件自带设置页栏目:打开 **Settings(设置)→ 左侧菜单 "MLX 模型"**(位于"模型"与"插件"之间),无需命令行即可:

- **启停服务** — 一键启动/停止(启动前可选模型;启动为异步发起,状态自动刷新,启动中也可停止)
- **切换模型** — 下拉选择模型目录中的模型,一键切换(自动停旧启新)
- **API 接入** — 展示并一键复制 OpenAI 兼容 API 地址(`http://127.0.0.1:<port>/v1`)
- **查看状态** — 运行状态、当前模型、pid、端口、运行时长、最近日志
- **设置参数** — 默认模型、端口、autoStart、registerProvider(可选的内置 provider 路由)、所选模型的 `thinking` 思考开关、思考模式(服务级)、附加启动参数,保存即持久化
- **退出清理** — DSH 退出时同步 SIGTERM 服务进程组,并派发 detached 兜底脚本,SIGKILL 残留;服务随 DSH 一起退出
- **残留回收** — 检测到端口被异常进程占用(疑似卡死/孤儿)时提示,可直接点击"回收残留服务"清理对应 Python 进程

> 栏目通过插件自带的 `/mlx/api` 接口与 host 通信(仅本机回环同源可访问);参数保存后写入设置命名空间 `mlx-local`。

## 文件与日志

| 路径 | 内容 |
|---|---|
| `~/.dsh/mlx/venv/` | Python 虚拟环境 |
| `~/.dsh/mlx/logs/server.log` | 服务日志(追加) |
| `~/.cache/huggingface/hub/` | 模型权重缓存 |

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [故障排查](docs/TROUBLESHOOTING.md)
