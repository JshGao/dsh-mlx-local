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
- Registers neither a system-prompt section nor any tools: the plugin is pure infrastructure for running the local model, and adds no fixed per-request cost to any session.

## Requirements

| Item | Requirement |
|---|---|
| Hardware | Apple Silicon (M-series) Mac |
| OS | macOS 13 or later |
| DSH | DeepSeek Harness **0.1.7-rc.1 or newer** (verified up to 0.2.0-rc.1) and a working `dsh` command |
| Python | 3.9–3.13, recommended 3.10–3.12; the plugin suggests `brew install python@3.12` when missing |
| Network | Internet is needed the first time to download Hugging Face weights |
| Disk | About 2–6 GB per 4-bit model |

## Version and updates

Current version: **0.5.1**. See [CHANGELOG.md](CHANGELOG.md) for the full history; only the upgrade-relevant parts are repeated here.

> **0.5.0 is a breaking release: it requires DSH 0.1.7 or newer, and the model catalogue needs a one-time manual migration.**

DSH 0.1.7 rewrote its settings architecture and removed the `settings.installSection` and `settings.get` APIs this plugin relied on. On **0.1.7-rc.2 and 0.2.0-rc.1 the old plugin was half-broken**: the "MLX 模型" Settings section disappeared and the boot chain (adopting an already-running service, the port monitor, the Qwen3 reasoning-effort backfill) stopped running — **without reporting a single error**. This release re-implements settings against the new architecture and requires DSH **0.1.7-rc.1 or newer**.

**Do the config migration once when upgrading.** DSH dropped `settings.yaml` and renamed the old file to `~/.dsh/settings.yaml.imported`, but this plugin's Config had no volatile fields at the time, so DSH skipped it during import and the model catalogue never reached the profile. Add this to your **profile's `cordis.patch.yml`** (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: dsh-mlx-local
  name: dsh-mlx-local
  config:
    models:
      - id: your-model-id
        repo: /absolute/path/or/HF-repo
        name: Display name
```

Then restart DSH. From that point on, edits made in the Settings page are saved normally and this file no longer needs hand-editing.

> **0.4.2 is a compatibility re-check against DSH 0.1.6-alpha.2 — no breaking changes.**

- Verified to load correctly on both **DSH 0.1.6-alpha.2** (the npm `alpha` tag) and 0.1.5-rc.2: named imports, services and methods, the `llm/stream` event, client slots and the `__ModuleLoader__` contract are all **unchanged**, so there is nothing to migrate.
- Fixed a client injection that had been **silently inert all along**: `dsh.client.inject` listed `@deepseek-ai/dsh-client-ui-slots`, which is never part of the client module graph (it is only a devDependency of official packages and carries no `dsh.client` declaration of its own), and the browser side skips unknown graph names without any error. It now lists `@deepseek-ai/dsh-client-ui-renderer`, the actual provider of the `slots` service. The "MLX 模型" section kept working only because a transitive dependency plus cordis service injection covered for it, so **there is no visible behaviour change when upgrading**.
- Installing on `0.1.6-alpha.x` makes npm report `ERESOLVE` — an inherent consequence of pre-release semver rules, and **official packages behave the same way**. Use `--legacy-peer-deps`; the promoted `0.1.6` release is unaffected.

> **0.4.1 is a breaking release: the plugin no longer registers any tools.**

- **All `mlx_*` tools have been removed.** The ten tools from 0.4.0 (`mlx_status` / `mlx_list_models` / `mlx_add_model` / `mlx_remove_model` / `mlx_pull_model` / `mlx_setup` / `mlx_start` / `mlx_stop` / `mlx_switch_model` / `mlx_chat`) are gone: this plugin only runs the local model, and service and model-directory management belong to the Settings page rather than to the agent. **There is nothing to migrate** — everything the agent used to do is available under **Settings → MLX 模型**.
- **System-prompt injection has also been removed.** The plugin used to inject a short note about the local service into every conversation. It now adds **zero** fixed per-request cost to any session.
- `inject` is now `["llm"]` — the plugin no longer depends on the `tools` service, and `peerDependencies` drops `@deepseek-ai/dsh-tools`. A leftover `enableTools` value in older settings is ignored automatically.

> **Upgrading from 0.3.x or earlier? You also need the 0.4.0 changes:**

1. **Auto-start with DSH has been removed.** The service is now always started explicitly by you: the **Start** button in Settings. The `autoStart` config field is gone too; a leftover value in an older settings file is ignored automatically, so you do not need to edit `settings.yaml` by hand.
2. **DSH requirement raised to 0.1.5-rc.1.** The plugin was written against the `0.1.0-rc.x` line and **failed to load at all** on 0.1.5-rc.1 (three named imports were removed upstream); the client half also needed a service rename and a section-order fix. **Do not use 0.2.x or earlier on 0.1.5.**

0.3.0–0.3.3 were never published separately; their changes are folded into 0.4.0.

### Upgrading

Installing, updating, and removing a standard plugin all modify the profile, so a DSH restart is required. To upgrade from an older version, remove first and then install:

```bash
dsh plugin --profile web remove dsh-mlx-local
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.5.1/dsh-mlx-local-0.5.1.tgz
```

Then restart DSH. Model directories and other settings live in `settings.yaml` and survive the upgrade.

## Installation

### Option 1: GitHub Release tarball

Install directly:

```bash
dsh plugin --profile web add https://github.com/JshGao/dsh-mlx-local/releases/download/v0.5.1/dsh-mlx-local-0.5.1.tgz
```

If DSH does not follow redirects, download it manually first:

```bash
curl -L -O https://github.com/JshGao/dsh-mlx-local/releases/download/v0.5.1/dsh-mlx-local-0.5.1.tgz
dsh plugin --profile web add ./dsh-mlx-local-0.5.1.tgz
```

Restart DSH after installing.

### Option 2: Build from source

```bash
git clone https://github.com/JshGao/dsh-mlx-local.git
cd dsh-mlx-local
npm install
npm run pack
dsh plugin --profile web add ./dsh-mlx-local-0.5.1.tgz
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
- The service is **never started automatically with DSH**: you start it explicitly from the Settings page each time, so it never claims memory behind your back.
- Hugging Face models are downloaded automatically on first start; you can also pre-download the weights into the local cache from the Settings page.
- Switching models stops the old service first, then starts the new one.
- The plugin does not register an `mlx-local` provider; use DSH's custom provider for access.

## Uninstall

```bash
dsh plugin --profile web remove dsh-mlx-local
```

Then restart DSH. Plugin settings and the venv/log files under `~/.dsh/mlx/` are kept; to remove them completely, delete `~/.dsh/mlx/` and the Hugging Face cache manually.

## Troubleshooting

See [docs/TROUBLESHOOTING.en.md](docs/TROUBLESHOOTING.en.md).
