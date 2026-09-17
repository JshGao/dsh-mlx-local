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
- 不注册额外 provider,继续使用 DSH 的“自定义提供方”接入;
- 不注册系统提示词段,也**不注册任何工具**:插件只是把本地模型跑起来的基础设施,不会给任何会话增加固定请求成本。

## 环境要求

| 项目 | 要求 |
|---|---|
| 硬件 | Apple Silicon(M 系列)Mac |
| 系统 | macOS 13 或更高 |
| DSH | DeepSeek Harness 0.1.5-rc.1 或更高(已实测至 0.1.6-alpha.2)及可用的 `dsh` 命令 |
| Python | 3.9–3.13,建议 3.10–3.12;未安装时插件会给出 `brew install python@3.12` 提示 |
| 网络 | 首次使用 HF 模型时需要联网下载权重 |
| 磁盘 | 每个 4-bit 模型约 2–6 GB |

## 版本与更新

当前版本 **0.4.2**。逐版变更见 [CHANGELOG.md](CHANGELOG.md);这里只列升级前必须知道的。

> **0.4.2 是针对 DSH 0.1.6-alpha.2 的兼容性复核,无破坏性变更。**

- 已实测在 **DSH 0.1.6-alpha.2**(npm `alpha` 标签)与 0.1.5-rc.2 上均可正常加载:具名导入、服务与方法、`llm/stream` 事件、客户端槽与 `__ModuleLoader__` 契约**全部未变**,无需迁移。
- 修掉一处**一直静默失效**的客户端注入:`dsh.client.inject` 原写的 `@deepseek-ai/dsh-client-ui-slots` 从来不在客户端模块图内(它只是官方包的 devDependency,自身没有 `dsh.client` 声明),而浏览器端对图里没有的名字会直接跳过、不报错。已改为 `slots` 服务的真正提供者 `@deepseek-ai/dsh-client-ui-renderer`。此前「MLX 模型」栏目能正常显示是靠传递依赖与 cordis 服务注入兜住,故**升级后无可见行为变化**。
- 装 `0.1.6-alpha.x` 时 npm 会报 `ERESOLVE`——这是预发布 semver 规则的固有行为,**官方包同样如此**,用 `--legacy-peer-deps` 绕过即可;转正后的 `0.1.6` 不受影响。

> **0.4.1 是破坏性更新:插件不再注册任何工具。**

- **移除了全部 `mlx_*` 工具。** 0.4.0 的 10 个工具(`mlx_status` / `mlx_list_models` / `mlx_add_model` / `mlx_remove_model` / `mlx_pull_model` / `mlx_setup` / `mlx_start` / `mlx_stop` / `mlx_switch_model` / `mlx_chat`)整体下线:本插件只负责把本地模型跑起来,服务与模型目录的管理请在设置页完成,不再由智能体代劳。**没有需要迁移的调用**——原先让智能体做的事,在 **设置 → MLX 模型** 里都能手动完成。
- **同时移除了系统提示词注入。** 此前插件会向每段对话注入一小段本地服务说明。现在插件对任何会话的固定请求成本都是 **0**。
- `inject` 收敛为 `["llm"]`,不再依赖 `tools` 服务,`peerDependencies` 去掉了 `@deepseek-ai/dsh-tools`;旧设置里残留的 `enableTools` 会被自动忽略。

> **从 0.3.x 及更早版本升级,还需要知道 0.4.0 的变更:**

1. **移除了「随 DSH 启动自动拉起服务」。** 服务现在一律由你显式启动——设置页的「启动」按钮。配置项 `autoStart` 同时删除;旧设置里若残留该字段会被自动忽略,不需要手动改 `settings.yaml`。
2. **DSH 要求提高到 0.1.5-rc.1。** 插件此前面向 `0.1.0-rc.x` 编写,在 0.1.5-rc.1 上**完全无法加载**(三个具名导入已被上游移除);同时客户端有服务改名与栏目排序的修复。**0.2.x 及更早版本请勿在 0.1.5 上使用。**

0.3.0–0.3.3 未单独发布,内容已并入 0.4.0。

### 升级

标准插件的安装/更新/卸载都会改 profile,需要重启 DSH 后生效。从旧版本升级时先移除再安装:

```bash
dsh plugin --profile web remove dsh-mlx-local
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.4.2/dsh-mlx-local-0.4.2.tgz
```

然后重启 DSH。模型目录等设置保存在 `settings.yaml` 中,升级不会丢失。

## 安装

### 方式一:使用 GitHub Release 发布包

直接安装:

```bash
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.4.2/dsh-mlx-local-0.4.2.tgz
```

如果 DSH 不跟随下载跳转,先手动下载:

```bash
curl -L -O https://github.com/JshGao/dsh-mlx-local/releases/download/v0.4.2/dsh-mlx-local-0.4.2.tgz
dsh plugin --profile web add ./dsh-mlx-local-0.4.2.tgz
```

安装后重启 DSH。

### 方式二:从源码安装

```bash
git clone https://github.com/JshGao/dsh-mlx-local.git
cd dsh-mlx-local
npm install
npm run pack
dsh plugin --profile web add ./dsh-mlx-local-0.4.2.tgz
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
- 服务**不随 DSH 启动自动拉起**:每次都由你在设置页显式启动,以免在意想不到的时候占用内存。
- HF 模型首次启动时会自动下载,也可以先用「预下载」把权重拉到本地缓存。
- 切换模型会先停止旧服务再启动新服务。
- 插件不会自动注册 `mlx-local` provider;接入统一使用 DSH 自定义 provider。

## 卸载

```bash
dsh plugin --profile web remove dsh-mlx-local
```

然后重启 DSH。插件设置和 `~/.dsh/mlx/` 下的 venv、日志会保留;如需彻底删除,可手动删除 `~/.dsh/mlx/` 和 HuggingFace 缓存。

## 常见问题

见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。
