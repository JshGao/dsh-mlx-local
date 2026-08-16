# dsh-mlx-local

> This plugin was granted as a wish from DSH. I am not responsible for the spaghetti code inside.

Run local large language models on Apple Silicon Macs through DSH. The plugin manages the Python environment, starts and stops `mlx_lm.server`, and connects the local service to DSH's built-in custom provider flow.

## Features

- Adds an **MLX 模型 (MLX Models)** section in Settings to start, stop, and switch local models;
- Auto-detects Python 3.9–3.13, creates a dedicated venv, and installs `mlx-lm`;
- Model directory management: add, remove, pre-download, and list local models;
- Detects abnormal service exits, reclaims leftover processes, and automatically stops the service when DSH exits;
- Automatically configures thinking strength for local Qwen3 models; the model picker shows Off / High;
- Does not register an extra provider — use DSH's **Custom Provider** as usual.

## Requirements

| Item | Requirement |
|---|---|
| Hardware | Apple Silicon (M-series) Mac |
| OS | macOS 13 or later |
| DSH | DeepSeek Harness 0.1.0-rc.6 and a working `dsh` command |
| Python | 3.9–3.13, recommended 3.10–3.12; the plugin suggests `brew install python@3.12` when missing |
| Network | Internet is needed the first time to download Hugging Face weights |
| Disk | About 2–6 GB per 4-bit model |

## Installation

### Option 1: GitHub Release tarball

Install directly:

```bash
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.2.3/dsh-mlx-local-0.2.3.tgz
```

If DSH does not follow redirects, download it manually first:

```bash
curl -L -O https://github.com/JshGao/dsh-mlx-local/releases/download/v0.2.3/dsh-mlx-local-0.2.3.tgz
dsh plugin --profile web add ./dsh-mlx-local-0.2.3.tgz
```

Restart DSH after installing.

### Option 2: Build from source

```bash
git clone https://github.com/JshGao/dsh-mlx-local.git
cd dsh-mlx-local
npm install
npm run pack
dsh plugin --profile web add ./dsh-mlx-local-0.2.3.tgz
```

Then restart DSH.

> Installing, updating, or uninstalling a standard plugin modifies the profile and requires a DSH restart to take effect.

## Quick Start

1. After restarting DSH, open **Settings → MLX 模型**;
2. If you already have an MLX model directory, click **加载模型… (Load Model…)** and choose it; otherwise use the built-in Hugging Face models;
3. Select a model and click **启动 (Start)**, then wait until the status becomes "running";
4. In **Settings → Models → Add Provider**:
   - Choose **Custom Provider**;
   - Use any route name, e.g. `local`;
   - Protocol: `openai-completions`;
   - Base URL: `http://127.0.0.1:8080/v1`;
   - Model ID: the model ID shown in the MLX plugin section;
   - API Key: any value; the local service does not validate it.
5. Start a new session and select that provider. For Qwen3 models, the thinking strength shows Off / High.

## Model Management

- Local model directories are saved in Settings; you can also load another local MLX model directory from the Settings page.
- Hugging Face models are downloaded automatically on first start; you can also pre-download them with `mlx_pull_model`.
- Switching models stops the old service first, then starts the new one.
- The plugin does not register an `mlx-local` provider; use DSH's custom provider for access.

## Uninstall

```bash
dsh plugin --profile web remove dsh-mlx-local
```

Then restart DSH. Plugin settings and the venv/log files under `~/.dsh/mlx/` are kept; to remove them completely, delete `~/.dsh/mlx/` and the Hugging Face cache manually.

## Troubleshooting

See [docs/TROUBLESHOOTING.en.md](docs/TROUBLESHOOTING.en.md).
