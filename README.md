# dsh-mlx-local

在 Apple Silicon 上用 [MLX](https://github.com/ml-explore/mlx) 框架运行本地大模型的 DeepSeek Harness 插件。

- **加载不同的模型** — 维护一个模型目录(HF 仓库或本地路径),随时 `mlx_switch_model` 切换服务加载的模型
- **开启/停止服务** — 以子进程管理 `mlx_lm.server`(OpenAI 兼容 API),启动、停止、状态、崩溃检测、残留进程回收一应俱全
- **不注册额外 provider** — 继续使用你已有的自定义提供方;插件拦截本地 openai-completions 请求,把主界面选择的思考强度正确翻译给 `mlx_lm.server`
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

### 方式 A:标准 npm 插件(功能完整,安装/卸载需重启 DSH)

标准插件包含完整 `mlx_*` 工具、设置页栏目与 `/mlx/api`,并通过拦截器优化自定义提供方的本地思考强度:

```bash
dsh plugin --profile web add /Users/jianshun/Documents/DeepSeekHarness/dsh-mlx-local
# 或安装发布包:
dsh plugin --profile web add dsh-mlx-local-0.2.2.tgz
```

卸载:

```bash
dsh plugin --profile web remove dsh-mlx-local
```

`dsh plugin add/remove` 修改 profile 依赖与 bundle 栈,**需要重启 DSH 才会装载/卸载插件**;插件本身已实现完整 dispose,卸载后重启不会残留本地模型服务。配置写入 DSH 设置命名空间 `mlx-local`(`~/.dsh/settings.yaml`)。

### 方式 B:动态插件(真正不关 DSH 的热插拔)

`dsh-mlx-local.dyn.js` 导出的 `HOST_CODE` / `CLIENT_CODE` 是动态沙箱版模板:**在对话中执行 `cordis_define` + `cordis_run(mode:"run")` 即可安装,`cordis_run(mode:"update")` 更新,`cordis_stop` 停止,`cordis_undefine` 永久移除——全程无需重启 DSH**。动态版只提供服务控制工具与精简设置面板,不含 `llm/stream` 思考强度拦截器。

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

### 热插拔、停用与退出行为

| 场景 | 行为 |
|---|---|
| 动态插件更新(`cordis_define` + `cordis_run(mode:"update")`) | 旧实例 dispose → 同步终止服务进程组 → 新实例接管;更新无需重启 DSH |
| 标准插件热重载 / `dsh plugin remove` | 插件 fiber 卸载时执行同一 dispose 清理,`bootTimer`/轮询定时器一并取消 |
| DSH 正常退出 | `dispose` 同步 SIGTERM + `process.exit` 同步 SIGKILL 兜底 |
| DSH 被强杀 | detached 监督进程检测父 pid 消失,1–5 秒内结束 python |
| 残留进程 | 新实例启动时自动 `adopt`;设置页也可点击"回收残留服务" |

## 快速开始

安装/激活插件后,新会话中智能体即可使用 `mlx_*` 工具。典型流程:

1. **查看状态**(一切从这里开始)
   `mlx_status` — 服务状态、当前模型、最近日志、Python 环境。

2. **启动服务**
   `mlx_start` — 默认加载目录中第一个模型(或 `defaultModel`)。就绪后状态自动变为 `running`。

3. **让 DSH 跑在本地模型上**
   - 继续使用你已经配置的“自定义提供方” `local`(openai-completions → `http://127.0.0.1:8080/v1`,API Key 任意值);
   - 插件不会注册额外 provider;首次激活时会自动为指向本地服务的 Qwen3 模型补全思考配置;
   - 之后在主界面对话框选择该本地模型时,会像其他思考模型一样显示 **Off / High** 思考强度;
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
| `thinkMode` | `auto` | 服务级思考默认值:auto/on/off;auto 时按各模型 `thinking` 字段决定(Qwen3 自动开启) |
| `serverArgs` | `[]` | 附加启动参数 |
| `venvPython` | 自动探测/创建 | `~/.dsh/mlx/venv/bin/python`(Python 3.9–3.13 + mlx-lm) |
| `models` | 内置 3 个 HF 模型 | 模型目录;每项可设置 `thinking`;当前机器设置中已保存为 `~/Documents/LLM Model/` 下的本地模型 |

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

### 接入方式:自定义提供方

在 **设置 → 模型 → 添加 provider** 中:

1. 选择 **自定义提供方**;
2. route 名:任意(如 `local`);
3. 协议:**`openai-completions`**;
4. baseURL:`http://127.0.0.1:8080/v1`(设置 → MLX 模型 栏目中展示,可一键复制);
5. 模型 id 与 API Key 填任意值(本地服务不校验)。

插件会自动升级指向本地服务的 Qwen3 模型配置,使主界面模型选择器显示 **Off / High** 思考强度;实际请求由插件的 `llm/stream` 拦截器直接发给 `mlx_lm.server`,并把思考强度翻译为 `chat_template_kwargs`。

## 设置页栏目(Web UI)

插件自带设置页栏目:打开 **Settings(设置)→ 左侧菜单 "MLX 模型"**(位于"模型"与"插件"之间),无需命令行即可:

- **启停服务** — 一键启动/停止(启动前可选模型;启动为异步发起,状态自动刷新,启动中也可停止)
- **切换模型** — 下拉选择模型目录中的模型,一键切换(自动停旧启新)
- **API 接入** — 展示并一键复制 OpenAI 兼容 API 地址(`http://127.0.0.1:<port>/v1`)
- **查看状态** — 运行状态、当前模型、pid、端口、运行时长、最近日志
- **设置参数** — 默认模型、端口、autoStart、思考模式(服务级默认值)、附加启动参数,保存即持久化
- **退出清理** — DSH 退出/插件停用/热插拔时同步终止服务进程组;即使 DSH 被强杀,监督进程也会杀死 python
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
