/**
 * dsh-mlx-local 动态插件模板(完全热插拔版)
 *
 * 用法:
 *  1. 激活(对话中让模型执行):
 *       cordis_define(plugin: {kind:"new", idPrefix:"mlx"}, code.host: <HOST_CODE>, code.client: <CLIENT_CODE>)
 *       cordis_run(mode:"new")
 *  2. 更新(无需重启 DSH):
 *       cordis_define(plugin: {kind:"existing", pluginId:<id>}, code.host: <新HOST_CODE>, code.client: <新CLIENT_CODE>)
 *       cordis_run(mode:"update")
 *  3. DSH 重启后:动态插件不持久,重复步骤 1(配置保存在 ~/.dsh/mlx/config.json,自动继承;
 *     若残留模型服务进程,激活时自动接管)。
 *
 * 使用 web profile 已有的 shell 服务;不要额外挂载 @deepseek-ai/dsh-bash-local,
 * 否则会与内置 bash-sandbox 重复注册 shell 并导致 DSH 启动失败。
 * 沙箱约束(host 半):无 require/fetch/setTimeout;注入 shell(进程)/timer(定时,
 * 用 ctx.timeout/ctx.interval);网络探测用 shell 命令(curl);配置存文件(shell 读写)。
 */
export const HOST_CODE = `
return {
	name: 'mlx-local-dyn',
	inject: ['shell', 'timer'],
	apply(ctx) {
		//#region 基础
		let home = '/Users/jianshun';
		let homeLoaded = false;
		const defaultsForHome = (base) => ({
			host: '127.0.0.1',
			port: 8080,
			defaultModel: 'qwen3-8b',
			autoStart: true,
			thinkMode: 'auto',
			serverArgs: [],
			venvPython: base + '/.dsh/mlx/venv/bin/python',
			models: [
				{ id: 'qwen3-8b', repo: base + '/Documents/LLM Model/mlx-community-Qwen3-8B-4bit', name: 'Qwen3 8B (4bit,工具调用)' },
				{ id: 'llama-3.2-3b', repo: base + '/Documents/LLM Model/mlx-community-Llama-3.2-3B-Instruct-4bit', name: 'Llama 3.2 3B (4bit)' }
			]
		});
		let proc = null;          // shell.start 句柄
		let state = 'stopped';    // stopped | starting | running | stopping
		let modelId = null;
		let modelRepo = null;
		let startedAt = null;
		let adopted = false;
		let portInUse = false;
		let lastAdopt = 0;
		let readyTimer = null;
		let ring = [];            // 最近日志(内存)
		const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
		const log = (line) => { ring.push(now() + ' ' + line); if (ring.length > 300) ring.shift(); };
		//#endregion

		//#region shell 辅助
		const run = async (command, timeoutMs) => {
			try {
				const res = await ctx.shell.run(ctx.shell.resolve({ command, ...(timeoutMs ? { timeoutMs } : {}) }));
				return { status: res.exitCode ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
			} catch (e) {
				return { status: -1, stdout: '', stderr: String((e && e.message) || e) };
			}
		};
		const ensureHome = async () => {
			if (homeLoaded) return home;
			const r = await run('echo $HOME', 5000);
			const candidate = (r.stdout || '').trim();
			if (candidate.length > 1) home = candidate;
			homeLoaded = true;
			return home;
		};
		const configPath = async () => (await ensureHome()) + '/.dsh/mlx/config.json';
		const expandPath = async (path) => {
			const base = await ensureHome();
			if (path === '~') return base;
			if (path.startsWith('~/')) return base + path.slice(1);
			return path;
		};
		const listenPids = async (port) => {
			const r = await run('lsof -nP -i :' + port + ' -sTCP:LISTEN -t', 10000);
			return (r.stdout || '').trim().split('\\n').map((s) => s.trim()).filter((s) => /^\\d+$/.test(s)).map(Number);
		};
		const pythonPids = async (port) => {
			const r = await run('lsof -nP -i :' + port + ' -sTCP:LISTEN', 10000);
			const pids = [];
			for (const line of (r.stdout || '').split('\\n').slice(1)) {
				const parts = line.trim().split(/\\s+/);
				if (parts.length >= 2 && /python/i.test(parts[0])) pids.push(Number(parts[1]));
			}
			return pids;
		};
		const health = async (host, port) => {
			const r = await run("curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://" + host + ':' + port + '/health', 6000);
			return r.stdout.trim() === '200';
		};
		const modelsOf = async (host, port) => {
			const r = await run('curl -s --max-time 3 http://' + host + ':' + port + '/v1/models', 8000);
			try { const d = JSON.parse(r.stdout); return Array.isArray(d.data) ? d.data : []; } catch { return null; }
		};
		const fileExists = async (path) => {
			const r = await run('test -f "' + path + '" && echo yes', 4000);
			return r.stdout.trim() === 'yes';
		};
		//#endregion

		//#region 配置(文件)
		const loadConfig = async () => {
			const path = await configPath();
			const defaults = defaultsForHome(home);
			const r = await run("cat '" + path + "' 2>/dev/null || echo '{}'", 5000);
			try {
				const saved = JSON.parse(r.stdout || '{}');
				const models = Array.isArray(saved.models) ? saved.models : defaults.models;
				return { ...defaults, ...saved, models };
			} catch { return defaults; }
		};
		const saveConfig = async (cfg) => {
			const path = await configPath();
			const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
			await run("echo '" + b64 + "' | base64 -d > '" + path + "'", 5000);
		};
		const resolveModel = (ref, cfg) => {
			if (ref) {
				const hit = cfg.models.find((m) => m.id === ref);
				return hit ? { id: hit.id, repo: hit.repo } : { id: ref, repo: ref };
			}
			if (cfg.defaultModel) {
				const hit = cfg.models.find((m) => m.id === cfg.defaultModel);
				if (hit) return { id: hit.id, repo: hit.repo };
			}
			if (cfg.models.length) return { id: cfg.models[0].id, repo: cfg.models[0].repo };
			throw new Error('模型目录为空');
		};
		const weightAvailable = async (m) => {
			const repo = await expandPath(m.repo);
			if (repo.startsWith('/')) {
				return (await fileExists(repo + '/config.json')) &&
					((await fileExists(repo + '/model.safetensors')) || (await fileExists(repo + '/model.safetensors.index.json')));
			}
			return true;
		};
		//#endregion

		//#region 服务管理
		const status = async () => {
			const cfg = await loadConfig();
			let pid = null;
			if (state === 'running' || state === 'starting') {
				const pids = await pythonPids(cfg.port);
				pid = pids.length ? pids[0] : null;
			}
			return {
				server: {
					state, pid, host: cfg.host, port: cfg.port,
					modelId, modelRepo,
					startedAt, uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
					portInUse, adopted,
					recentLog: ring.slice(-30)
				},
				config: { ...cfg, models: cfg.models.map((m) => ({ id: m.id, repo: m.repo, name: m.name ?? m.id })) }
			};
		};
		const start = async (ref) => {
			if (state === 'running' || state === 'starting') return status();
			const cfg = await loadConfig();
			const target = resolveModel(ref, cfg);
			if (await health(cfg.host, cfg.port)) { await adopt(); return status(); }
			const stray = await pythonPids(cfg.port);
			if (stray.length) {
				log('端口 ' + cfg.port + ' 被残留进程(pid ' + stray.join(',') + ')占用且无响应,先回收再启动');
				for (const p of stray) await run('kill ' + p + ' 2>/dev/null; sleep 1; kill -9 ' + p + ' 2>/dev/null', 6000);
			}
			const thinkArgs = cfg.thinkMode === 'on' || cfg.thinkMode === 'off'
				? "--chat-template-args '{\\"enable_thinking\\":" + (cfg.thinkMode === 'on') + "}'" : '';
			const command = "'" + cfg.venvPython + "' -m mlx_lm.server --model '" + target.repo +
				"' --host " + cfg.host + ' --port ' + cfg.port +
				(thinkArgs ? ' ' + thinkArgs : '') +
				(cfg.serverArgs && cfg.serverArgs.length ? ' ' + cfg.serverArgs.join(' ') : '');
			log('启动服务: ' + command);
			state = 'starting';
			modelId = target.id; modelRepo = target.repo; startedAt = Date.now();
			proc = await ctx.shell.start(ctx.shell.resolve({
				command,
				env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
			}));
			proc.done.then((outcome) => {
				if (state !== 'stopping') {
					state = 'stopped';
					log('服务进程退出(' + JSON.stringify(outcome) + ')');
				}
				proc = null;
			});
			if (readyTimer) readyTimer();
			readyTimer = ctx.interval(1000, async () => {
				if (state === 'starting' && await health(cfg.host, cfg.port)) {
					state = 'running';
					log('服务就绪: http://' + cfg.host + ':' + cfg.port + ' 模型 ' + target.repo);
					if (readyTimer) { readyTimer(); readyTimer = null; }
				}
			});
			return status();
		};
		const stop = async () => {
			if (proc) {
				state = 'stopping';
				await proc.kill();
				proc = null;
			} else if (adopted) {
				const cfg = await loadConfig();
				const pids = await pythonPids(cfg.port);
				for (const p of pids) await run('kill ' + p + ' 2>/dev/null; sleep 1; kill -9 ' + p + ' 2>/dev/null', 6000);
			}
			state = 'stopped'; adopted = false; modelId = null; modelRepo = null; startedAt = null;
			log('服务已停止');
			return status();
		};
		const switchModel = async (ref) => { await stop(); return start(ref); };
		const recover = async () => {
			if (proc || state === 'running' || state === 'starting') throw new Error('服务正在运行/启动中,无需回收;请先停止服务');
			const cfg = await loadConfig();
			const pids = await pythonPids(cfg.port);
			for (const p of pids) await run('kill ' + p + ' 2>/dev/null; sleep 1; kill -9 ' + p + ' 2>/dev/null', 6000);
			portInUse = (await pythonPids(cfg.port)).length > 0;
			log('已回收端口 ' + cfg.port + ' 上的残留进程(pid ' + pids.join(',') + ')');
			return { recovered: pids, port: cfg.port, portInUse };
		};
		const adopt = async () => {
			if (state !== 'stopped' || proc) return false;
			const cfg = await loadConfig();
			if (!(await health(cfg.host, cfg.port))) return false;
			const models = await modelsOf(cfg.host, cfg.port);
			if (models === null) { portInUse = true; return false; }
			const pids = await listenPids(cfg.port);
			const entry = cfg.models.find((m) => models.some((d) => d.id === m.repo));
			state = 'running'; adopted = true;
			modelId = entry ? entry.id : null; modelRepo = entry ? entry.repo : null;
			startedAt = Date.now(); portInUse = false;
			log('已接管外部运行中的 MLX 服务(pid=' + (pids[0] ?? '?') + (entry ? ',模型 ' + entry.repo : ',模型未知') + ')');
			return true;
		};
		ctx.interval(5000, async () => {
			const cfg = await loadConfig();
			const ok = await health(cfg.host, cfg.port);
			if (!ok) {
				if (adopted) { state = 'stopped'; adopted = false; modelId = null; modelRepo = null; log('被接管的外部服务已停止'); }
				const stray = await pythonPids(cfg.port);
				if (!stray.length) { if (portInUse) { portInUse = false; log('端口残留已消失,占用标记已清除'); } }
				else if (!portInUse) { portInUse = true; log('端口 ' + cfg.port + ' 有进程在监听但不响应 /health,疑似卡死'); }
				return;
			}
			if (state === 'stopped' && !proc && !adopted) {
				const n = Date.now();
				if (n - lastAdopt > 15000) { lastAdopt = n; const ok2 = await adopt(); if (!ok2) portInUse = true; }
				else portInUse = true;
			}
		});
		ctx.on('dispose', () => { try { if (proc) proc.kill(); } catch {} });
		const boot = async () => {
			const cfg = await loadConfig();
			const adoptedOk = await adopt();
			if (!adoptedOk && cfg.autoStart && cfg.defaultModel) await start(cfg.defaultModel);
		};
		ctx.timeout(1500, boot);
		//#endregion

		//#region 工具
		const tool = (name, description, parameters, execute) => harness.defineTool({
			name, description, parameters,
			output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
			execute
		});
		harness.registerTool(tool('mlx_status', '查看本地 MLX 模型服务状态', {}, async () => status()));
		harness.registerTool(tool('mlx_start', '启动本地 MLX 模型服务(mlx_lm.server,OpenAI 兼容 API)', { model: { type: 'string', description: '模型 id 或本地路径;可选' } }, async (args) => start(args.model)));
		harness.registerTool(tool('mlx_stop', '停止本地 MLX 模型服务', {}, async () => stop()));
		harness.registerTool(tool('mlx_switch_model', '切换服务加载的模型(先停后启)', { model: { type: 'string', required: true, description: '目标模型 id 或本地路径' } }, async (args) => switchModel(args.model)));
		harness.registerTool(tool('mlx_list_models', '列出模型目录', {}, async () => {
			const cfg = await loadConfig();
			return { activeModelId: modelId, models: cfg.models.map((m) => ({ id: m.id, repo: m.repo, name: m.name ?? m.id, active: m.id === modelId })) };
		}));
		harness.registerTool(tool('mlx_load', '从本地目录加载模型(加入列表,不自动启动)', { path: { type: 'string', required: true, description: 'MLX 模型目录路径' } }, async (args) => {
			const cfg = await loadConfig();
			const dir = await expandPath(args.path);
			if (!(await fileExists(dir + '/config.json')) ||
				!((await fileExists(dir + '/model.safetensors')) || (await fileExists(dir + '/model.safetensors.index.json')))) {
				throw new Error('所选目录不是 MLX 模型目录(缺少 config.json 或 model.safetensors)');
			}
			const name = dir.split('/').filter(Boolean).pop();
			const byId = new Map(cfg.models.map((m) => [m.id, m]));
			let action = 'added';
			if (byId.has(name)) { byId.set(name, { ...byId.get(name), repo: dir }); action = 'updated'; }
			else byId.set(name, { id: name, repo: dir, name });
			await saveConfig({ ...cfg, models: [...byId.values()] });
			return { action, model: { id: name, repo: dir } };
		}));
		harness.registerTool(tool('mlx_chat', '对运行中的服务发一次非流式对话', { message: { type: 'string', required: true, description: '用户消息' } }, async (args) => {
			const cfg = await loadConfig();
			if (state !== 'running') throw new Error('服务未运行:请先 mlx_start');
			const body = JSON.stringify({ messages: [{ role: 'user', content: args.message }], max_tokens: 256 });
			const r = await run("curl -s -X POST http://" + cfg.host + ":" + cfg.port + "/v1/chat/completions -H 'content-type: application/json' -d '" + body.replace(/'/g, "'\\''") + "'", 120000);
			try { const d = JSON.parse(r.stdout); return { content: d.choices?.[0]?.message?.content ?? '' }; }
			catch { return { error: r.stdout || r.stderr }; }
		}));
		//#endregion

		//#region client 通信
		harness.handle('status', async () => status());
		harness.handle('start', async (args) => start(args && args.model));
		harness.handle('stop', async () => stop());
		harness.handle('recover', async () => recover());
		harness.handle('switch', async (args) => switchModel(args && args.model));
		harness.handle('load', async (args) => {
			const cfg = await loadConfig();
			const dir = await expandPath(args.path);
			if (!(await fileExists(dir + '/config.json')) ||
				!((await fileExists(dir + '/model.safetensors')) || (await fileExists(dir + '/model.safetensors.index.json')))) {
				throw new Error('所选目录不是 MLX 模型目录(缺少 config.json 或 model.safetensors)');
			}
			const name = dir.split('/').filter(Boolean).pop();
			const byId = new Map(cfg.models.map((m) => [m.id, m]));
			if (byId.has(name)) { byId.set(name, { ...byId.get(name), repo: dir }); }
			else byId.set(name, { id: name, repo: dir, name });
			await saveConfig({ ...cfg, models: [...byId.values()] });
			return { ok: true, model: name };
		});
		harness.handle('setConfig', async (args) => {
			const cfg = await loadConfig();
			const next = { ...cfg, ...(args.patch || {}) };
			if (next.port !== undefined && (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535)) throw new Error('port 必须是 1-65535');
			await saveConfig(next);
			return { ok: true, config: next };
		});
		harness.handle('prune', async () => {
			const cfg = await loadConfig();
			const removed = [];
			const kept = [];
			for (const m of cfg.models) {
				if (m.id !== modelId && !(await weightAvailable(m))) removed.push({ id: m.id, repo: m.repo });
				else kept.push(m);
			}
			if (removed.length) await saveConfig({ ...cfg, models: kept });
			return { removed, models: kept.map((m) => ({ id: m.id, repo: m.repo })) };
		});
		//#endregion
	}
};
`;

export const CLIENT_CODE = `
return {
	name: 'mlx-local-client',
	inject: ['slots', 'timer'],
	apply(ctx) {
		const MlxSection = () => {
			const [view, setView] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [error, setError] = React.useState(null);
			const refresh = () => host.call('status').then((v) => { setView(v); setError(null); }).catch((e) => setError(String((e && e.message) || e)));
			React.useEffect(() => { refresh(); }, []);
			ctx.interval(5000, refresh);
			const act = (name, method, args) => {
				setBusy(name); setError(null);
				host.call(method, args || {}).then(refresh).catch((e) => setError(String((e && e.message) || e))).then(() => setBusy(null));
			};
			if (!view) return React.createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, error || '加载中…');
			const s = view.server || {};
			const c = view.config || {};
			const models = c.models || [];
			const running = s.state === 'running';
			const apiUrl = 'http://' + (s.host || '127.0.0.1') + ':' + (s.port || 8080) + '/v1';
			const dot = { running: '#22c55e', starting: '#eab308', stopped: '#94a3b8' }[s.state] || '#94a3b8';
			return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 } },
				React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 } },
					React.createElement('span', { style: { width: 10, height: 10, borderRadius: 5, background: dot, display: 'inline-block' } }),
					'MLX 模型服务 · ' + (s.state === 'running' ? '运行中' : s.state === 'starting' ? '启动中…' : '已停止')
				),
				React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
					'当前模型: ' + (s.modelRepo || '—') + (s.pid ? ' · pid ' + s.pid : '') + ' · ' + apiUrl + (s.adopted ? ' · 已接管遗留服务' : '')
				),
				React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
					React.createElement('button', { disabled: !!busy || running, onClick: () => act('start', 'start', {}) }, busy === 'start' ? '启动中…' : '启动'),
					React.createElement('button', { disabled: !!busy || !running, onClick: () => act('stop', 'stop', {}) }, busy === 'stop' ? '停止中…' : '停止')
				),
				s.portInUse ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-state-warn-label)' } },
					'检测到端口残留进程',
					React.createElement('button', { disabled: !!busy, onClick: () => act('recover', 'recover', {}) }, busy === 'recover' ? '回收中…' : '回收残留服务')
				) : null,
				React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
					'API 接入: ' + apiUrl + '(设置 → 模型 → 添加 provider,自定义提供方,协议 openai-completions,API Key 填任意值)'
				),
				React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
					'模型列表: ' + models.map((m) => m.name || m.id).join(' / ')
				),
				error ? React.createElement('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error) : null,
				React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
					'最近日志:' + (s.recentLog && s.recentLog.length ? React.createElement('pre', { style: { background: 'var(--dsw-alias-bg-module-platform)', padding: 8, borderRadius: 8, fontSize: 11, maxHeight: 150, overflow: 'auto' } }, s.recentLog.slice(-10).join('\\n')) : ' (暂无)')
				)
			);
		};
		ctx.slots.register({ name: 'settings.section', id: 'mlx-local', order: 12, label: () => 'MLX 模型' }, MlxSection);
	}
};
`;

export const ACTIVATE = [
	"注意:使用 web profile 已有的 shell 服务,不要额外挂载 @deepseek-ai/dsh-bash-local。",
	"1) 激活(对话中):",
	"   cordis_define(plugin: {kind:\"new\", idPrefix:\"mlx\"}, code.host: HOST_CODE, code.client: CLIENT_CODE)",
	"   cordis_run(mode: \"new\")",
	"2) 更新:重复 define(kind:\"existing\", pluginId) + run(mode:\"update\"),DSH 不重启。",
	"3) DSH 重启后:重新执行步骤 1(配置在 ~/.dsh/mlx/config.json,自动继承)。"
].join('\n');
