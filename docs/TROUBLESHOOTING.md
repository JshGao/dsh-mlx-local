# 故障排查

> 所有诊断的第一步:`mlx_status`。它返回服务状态、当前模型、最近日志(含子进程 stderr)与 Python 环境探测结果。

## Python 环境

### "未找到合适的 Python(需要 3.9–3.13)"
插件探测不到可用的 Python。按引导安装后重跑 `mlx_setup`:

```bash
brew install python@3.12
# 或从 https://www.python.org/downloads/ 下载安装
```

装好后无需配置任何东西——插件会自动在 `/opt/homebrew/bin`、`/usr/local/bin`、PATH 中探测。若装了多个版本,插件优先选 3.10–3.12 中最高的。

### `pip install mlx-lm` 失败
- **Python 版本过新/过旧**:mlx wheel 覆盖 3.9–3.13。安装 3.10–3.12 后重跑 `mlx_setup`。
- **网络问题**:重试即可;代理环境可先配置 `export https_proxy=...` 再重跑。
- **venv 损坏**:删除 `~/.dsh/mlx/venv` 后重跑 `mlx_setup`(权重缓存 `~/.cache/huggingface` 不受影响,无需重下)。

### 想换 venv 位置或指定 Python
Settings → Models → **MLX Local (Apple Silicon)**,设置 `venvDir` 与 `pythonBin`(基础 Python 绝对路径)。

## 服务启动

### "端口 8080 已被占用"
有进程已在 8080 响应。可能原因:
- 之前手动启动过 `mlx_lm.server`(或旧版插件实例残留):`lsof -nP -i :8080` 找到 pid 后结束它;
- 其他软件占用:在设置中把 `port` 改为其他值(如 8090)。

插件不会杀死占用方。

### "服务进程提前退出"
`mlx_status` 的最近日志会给出真实原因(常见):

| 日志特征 | 原因与处理 |
|---|---|
| `Error: Failed to fetch ... 404` | 模型仓库不存在或拼写错误:检查 `repo` |
| `403 / gated repo` | 模型是私有/需授权的(gated)。在 `~/.cache/huggingface/token` 写入 HF token(`huggingface-cli login`)后重试 |
| `Killed / MemoryError` | 内存不足:换更小的模型(如 3B),或加 `--max-kv-size` 限制 KV 缓存 |
| `Traceback ... chat template` | 模型不是对话模型或模板缺失:换指令微调(Instruct)模型 |

### 启动很慢/一直 starting
首次启动会从 HuggingFace 下载权重(2–6 GB),`mlx_status` 最近日志可见 `Fetching ...` 进度;下载完成后自动进入 `running`。若不想让首次请求等待,先 `mlx_pull_model` 预下载。

### 想限制显存/内存占用
启动时传附加参数,例如:

```
mlx_start  serverArgs: ["--max-kv-size", "4096"]
```

或写入设置 `serverArgs: ["--max-kv-size", "4096"]`。

## 模型管理

### 切换模型后请求报错
`mlx_switch_model` 会先停旧服务再启新服务,切换瞬间在途请求会被中断(适配器按 `ABORTED`/`STREAM_CLOSED` 报错)——属正常现象,重发即可。若切换后新服务未就绪,`mlx_status` 查看是否在下载。

### 添加的模型不在列表里
`mlx_add_model` 持久化到设置;若设置服务不可用会明确报错。模型 id 只能包含字母、数字、`._-`。

### 模型下载失败
- 检查网络与磁盘空间(每个模型 2–6 GB);
- 私有仓库需配置 HF token(见上);
- 下载进度与错误见 `mlx_status` 最近日志。

## 接入 DSH(提供者)

### 模型选择器里没有 mlx-local
这是预期行为:0.2.1 起 `registerProvider` **默认关闭**,推荐继续使用自定义提供方(如 `local` / openai-completions)。若想在模型选择器里看到 **MLX Local**,到 设置 → MLX 模型 勾选“在模型选择器中注册 mlx-local 提供者”并保存。

### 选中 mlx-local 模型后报 SERVER_OFFLINE / SERVER_MODEL_MISMATCH
- 默认 `serveOnDemand=true`,适配器会在推理前自动启动/切换服务;如果仍报 `SERVER_OFFLINE`,先让智能体执行 `mlx_status` 查看 Python 环境与最近日志(常见原因是 venv 未初始化或端口被占用)。
- 若在设置里关闭了 `serveOnDemand`,服务未运行会返回 `SERVER_OFFLINE`,模型不一致会返回 `SERVER_MODEL_MISMATCH`;执行 `mlx_start` / `mlx_switch_model`,或重新打开 `serveOnDemand` 即可。
- 也可以打开设置开启 `autoStart` + `defaultModel`,让 DSH 启动时自动拉起服务。

### Qwen3 思考开关
- 自定义提供方通道:用 设置 → MLX 模型 中的“思考模式”(服务级,下次启动生效)和所选模型的“开启思考(Qwen3)”复选框。
- 内置 `mlx-local` 通道:Qwen3 在模型选择器中显示“开启思考/关闭思考”,该开关通过请求级 `chat_template_kwargs` 即时生效,无需重启服务。

### 工具调用不生效(模型只会输出文本)
当前模型不支持函数调用。mlx_lm.server 只在模型的 tokenizer 支持工具时启用工具解析,推荐使用 **Qwen3** 系列(默认目录中的 `qwen3-8b`)。

### 回复里出现大段推理文本
Qwen3 等模型的思考过程会以 `reasoning` 块呈现,属正常现象;若不需要可在设置里不选该类模型。

## 其他

### DSH 重启后服务状态
正常退出时,插件 dispose 钩子会优雅停止服务进程;重启后 `mlx_status` 显示 `stopped`。若配置了 `autoStart`,会自动拉起。

若 DSH **异常退出**(强杀/崩溃),MLX 服务进程可能残留为孤儿进程(继续占用内存)。新实例启动时插件会**自动接管**它:探测端口上的服务(响应 `/v1/models`),记录 pid 与模型并置为运行中(状态显示"已接管上次遗留的服务"),之后可正常停止/切换;若端口被无法识别的服务占用,状态会标记"端口被占用",可在设置页直接点击**回收残留服务**(只清理该端口上的 Python 进程)。

### 日志在哪
- `mlx_status` 最近日志(环形缓冲 200 行);
- 完整日志:`~/.dsh/mlx/logs/server.log`;
- DSH 自身日志:插件事件以 `[dsh-mlx-local]` 前缀输出。

### 卸载插件
```bash
dsh plugin --profile web remove dsh-mlx-local
```
(服务进程会随 DSH 退出停止;`~/.dsh/mlx` 目录与 HF 缓存可手动删除。)
