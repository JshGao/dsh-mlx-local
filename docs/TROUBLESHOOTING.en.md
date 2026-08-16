# Troubleshooting

## Installation

### pnpm is not found or installation fails

Make sure `pnpm` and the `dsh` command are installed, then run again from the plugin directory:

```bash
dsh plugin --profile web add ./dsh-mlx-local-0.2.2.tgz
```

If it still fails, delete `~/.dsh/profiles/web/node_modules/dsh-mlx-local` and retry.

### No "MLX 模型" section in Settings after installation

- Make sure DSH has been restarted;
- Look for **MLX 模型** in the left menu of Settings;
- If it is still missing, check that the profile actually loads the plugin:

```bash
dsh --profile web --dump-config | grep dsh-mlx-local
```

## Python Environment

### "No suitable Python found"

Install Python 3.10–3.12:

```bash
brew install python@3.12
```

Then restart the plugin, or ask the agent to run `mlx_setup` in a conversation.

### Installing mlx-lm fails

- Check the network and retry;
- Delete `~/.dsh/mlx/venv` and run `mlx_setup` again;
- If the error mentions an incompatible Python version, install Python 3.10–3.12 and retry.

## Starting the Service

### Port is already in use

```bash
lsof -nP -i :8080
```

- If the port is used by something other than the local MLX service, change the port in Settings;
- If it is a leftover MLX process, click **回收残留服务 (Reclaim leftover service)** on the Settings page, or kill the PID manually.

### Service exits shortly after starting

Check the recent logs in **Settings → MLX 模型**. Common causes:

- Wrong model repository name;
- Private or gated model without an HF token;
- Not enough memory; try a smaller model or add `--max-kv-size`;
- The model is not a chat model.

### First start is slow

The first use of a Hugging Face model downloads weights, which is expected. You can pre-download with `mlx_pull_model` to make later starts faster.

## Connecting to DSH

### Local model requests report that the service is not running

Start the service first in **Settings → MLX 模型**, or ask the agent to run `mlx_start`.

### Local model requests report a model mismatch

The model ID selected in the custom provider does not match the model currently loaded by the service. Switch the service model, or change the model ID in the custom provider to the currently loaded model ID.

### Qwen3 has no thinking-strength option

The plugin automatically completes the thinking configuration for local Qwen3 models. Please confirm:

- The custom provider base URL is `http://127.0.0.1:8080/v1`;
- The model name or path contains `Qwen3`;
- DSH has been restarted and a new session was created before checking the model picker.

## Exit and Leftovers

### The local service does not stop after DSH exits

Normally the plugin stops the service when DSH exits. If you find a leftover process:

```bash
lsof -nP -i :8080 -sTCP:LISTEN
kill <PID>
```

On the next plugin start it will also take over or reclaim any leftover service.
