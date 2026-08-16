# dsh-mlx-local

> 本插件是向DSH许愿得到的，本人不对其中的屎山代码负责。

> [English](README.en.md) · [中文](README.md)

在 Apple Silicon Mac 上通过 DSH 运行本地大模型。插件负责管理 Python 环境、启动和停止 `mlx_lm.server`,并把本地服务接入 DSH 已有的自定义 provider。

## 功能

- 在设置页提供“MLX 模型”栏目,可启动、停止、切换本地模型;
- 自动探测 Python 3.9–3.13,创建独立 venv 并安装 `mlx-lm`;
- 模型目录管理:添加、移除、预下载、列出本地模型;
- 服务异常退出检测、残留进程回收、DSH 退出时自动关闭服务;
- 为本地 Qwen3 自动配置思考强度,主界面模型选择器可切换 Off / High;
- 不注册额外 provider,继续使用 DSH 的“自定义提供方”接入。

## 环境要求

| 项目 | 要求 |
|---|---|
| 硬件 | Apple Silicon(M 系列)Mac |
| 系统 | macOS 13 或更高 |
| DSH | DeepSeek Harness 0.1.0-rc.6 及可用的 `dsh` 命令 |
| Python | 3.9–3.13,建议 3.10–3.12;未安装时插件会给出 `brew install python@3.12` 提示 |
| 网络 | 首次使用 HF 模型时需要联网下载权重 |
| 磁盘 | 每个 4-bit 模型约 2–6 GB |

## 安装

### 方式一:使用 GitHub Release 发布包

直接安装:

```bash
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.2.3/dsh-mlx-local-0.2.3.tgz
```

如果 DSH 不跟随下载跳转,先手动下载:

```bash
curl -L -O https://github.com/JshGao/dsh-mlx-local/releases/download/v0.2.3/dsh-mlx-local-0.2.3.tgz
dsh plugin --profile web add ./dsh-mlx-local-0.2.3.tgz
```

安装后重启 DSH。

### 方式二:从源码安装

```bash
git clone https://github.com/JshGao/dsh-mlx-local.git
cd dsh-mlx-local
npm install
npm run pack
dsh plugin --profile web add ./dsh-mlx-local-0.2.3.tgz
```

然后重启 DSH。

> 安装、更新、卸载标准插件会修改 profile,需要重启 DSH 后生效。

## 快速开始

1. 重启 DSH 后打开 **设置 → MLX 模型**;
2. 如果本地已有 MLX 模型目录,点击 **加载模型…** 选择目录;否则可直接使用内置 HF 模型;
3. 选择模型后点击 **启动**,等待状态变为“运行中”;
4. 在 **设置 → 模型 → 添加 provider** 中:
   - 选择 **自定义提供方**;
   - route 名任意,例如 `local`;
   - 协议选择 `openai-completions`;
   - baseURL 填 `http://127.0.0.1:8080/v1`;
   - 模型 id 填 MLX 插件目录中显示的模型 id;
   - API Key 填任意值,本地服务不会校验。
5. 新建会话,在主界面选择该 provider。若模型是 Qwen3,思考强度会显示 Off / High。

## 模型管理

- 本地模型目录会保存在设置中;也可以在设置页中加载新的本地 MLX 模型。
- HF 模型首次启动时会自动下载,也可以使用 `mlx_pull_model` 预下载。
- 切换模型会先停止旧服务再启动新服务。
- 插件不会自动注册 `mlx-local` provider;接入统一使用 DSH 自定义 provider。

## 卸载

```bash
dsh plugin --profile web remove dsh-mlx-local
```

然后重启 DSH。插件设置和 `~/.dsh/mlx/` 下的 venv、日志会保留;如需彻底删除,可手动删除 `~/.dsh/mlx/` 和 HuggingFace 缓存。

## 常见问题

见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。
