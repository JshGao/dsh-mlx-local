# 故障排查

> [English](TROUBLESHOOTING.en.md) · [中文](TROUBLESHOOTING.md)

## 安装

### 提示 pnpm 找不到或安装失败

确认已安装 `pnpm` 和 `dsh` 命令,然后在插件目录重新执行:

```bash
dsh plugin --profile web add ./dsh-mlx-local-0.2.2.tgz
```

如果仍失败,删除 `~/.dsh/profiles/web/node_modules/dsh-mlx-local` 后重试。

### 安装后设置页没有“MLX 模型”

- 确认已重启 DSH;
- 在设置页左侧菜单中寻找 **MLX 模型**;
- 如果仍没有,检查 profile 是否加载了该插件:

```bash
dsh --profile web --dump-config | grep dsh-mlx-local
```

## Python 环境

### 提示未找到合适的 Python

安装 Python 3.10–3.12:

```bash
brew install python@3.12
```

然后重新启动插件,或在对话中让智能体执行 `mlx_setup`。

### 安装 mlx-lm 失败

- 检查网络,重试;
- 删除 `~/.dsh/mlx/venv` 后重新执行 `mlx_setup`;
- 如果提示版本不兼容,安装 Python 3.10–3.12 后重试。

## 服务启动

### 端口被占用

```bash
lsof -nP -i :8080
```

- 如果占用者不是本地 MLX 服务,修改设置中的端口;
- 如果是残留的 MLX 进程,在设置页点击“回收残留服务”,或手动结束对应 PID。

### 服务启动后很快退出

在 设置 → MLX 模型 中查看最近日志。常见原因:

- 模型仓库名错误;
- 私有或 gated 模型缺少 HF token;
- 内存不足,尝试更小的模型或添加 `--max-kv-size` 参数;
- 模型不是对话模型。

### 首次启动很慢

首次使用 HF 模型时会下载权重,这是正常现象。可以先执行 `mlx_pull_model` 预下载,下载完成后启动会快很多。

## 接入 DSH

### 本地模型请求报服务未运行

先在 设置 → MLX 模型 中启动服务,或让智能体执行 `mlx_start`。

### 本地模型请求报模型不一致

自定义 provider 中选择的模型 id 与当前服务加载的模型不一致。切换服务模型,或在自定义 provider 中把模型 id 改成当前加载模型的 id。

### Qwen3 没有思考强度选项

插件会自动为本地 Qwen3 补全思考配置。请确认:

- 自定义 provider 的 baseURL 是 `http://127.0.0.1:8080/v1`;
- 模型名称或路径中包含 `Qwen3`;
- 重启 DSH 后新建会话查看模型选择器。

## 退出与残留

### DSH 退出后本地服务没有停止

正常情况下插件会随 DSH 退出自动停止服务。如果发现残留:

```bash
lsof -nP -i :8080 -sTCP:LISTEN
kill <PID>
```

下次插件启动时也会自动接管或回收残留服务。
