/**
 * dsh-mlx-local 浏览器端:设置页左侧菜单的 "MLX 模型" 栏目。
 *
 * 注册到官方 `settings.section` 槽(通用设置=0、模型=10、插件=15 之间):
 * 页面内容自包含,轮询 host 的 /mlx/api 接口(仅本机回环同源可访问),
 * 提供:状态、启停服务、切换模型、参数保存、最近日志、残留服务回收。
 *
 * 手写 React(无 JSX/构建步骤),bundle 格式遵循 __ModuleLoader__ 约定。
 */
window.__ModuleLoader__.load({
	id: "dsh-mlx-local",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		//#region 样式(按插件命名空间注入)
		const CSS_ID = "dsh-mlx-local/card.css";
		const CSS = `
.mlx-page{display:flex;flex-direction:column;gap:14px;padding:4px 0}
.mlx-head{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.4}
.mlx-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px}
.mlx-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.mlx-dot-running{background:#22c55e}
.mlx-dot-starting{background:#eab308}
.mlx-dot-stopped{background:var(--dsw-alias-label-tertiary)}
.mlx-body{display:flex;flex-direction:column;gap:10px}
.mlx-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mlx-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;word-break:break-all}
.mlx-warn{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:1.5;margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mlx-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.mlx-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}
.mlx-btn:disabled{opacity:.45;cursor:default}
.mlx-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.mlx-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mlx-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;max-width:100%;flex:1;min-width:0}
.mlx-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px;width:90px}
.mlx-input-wide{width:100%}
.mlx-label{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px;white-space:nowrap}
.mlx-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;margin:0;word-break:break-all}
.mlx-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}
.mlx-log{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px 10px;margin:0;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary);max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.mlx-section{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.mlx-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0}
.mlx-api{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;flex:1;min-width:0}
.mlx-fieldRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`;
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mlx-local";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region /mlx/api 客户端
		async function call(method, payload = {}, signal) {
			let response;
			try {
				response = await fetch(`/mlx/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					signal
				});
			} catch (error) {
				throw new Error(`无法连接本地服务: ${error?.message ?? error}`);
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true) {
				throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
			}
			return parsed.value;
		}
		const api = {
			status: (signal) => call("status", {}, signal),
			start: (model, port, signal) => call("start", { model, port }, signal),
			stop: (signal) => call("stop", {}, signal),
			recover: (signal) => call("recover", {}, signal),
			switchModel: (model, signal) => call("switchModel", { model }, signal),
			setConfig: (patch, signal) => call("setConfig", { patch }, signal),
			load: (path, signal) => call("load", { path }, signal),
			prune: (signal) => call("prune", {}, signal)
		};
		//#endregion

		//#region 面板组件
		/** 状态徽章文案。 */
		function stateText(state) {
			switch (state) {
				case "running": return "运行中";
				case "starting": return "启动中…";
				case "stopping": return "停止中…";
				default: return "已停止";
			}
		}
		/** 显示时长。 */
		function uptimeText(seconds) {
			if (seconds === null || seconds === undefined) return "";
			if (seconds < 60) return `${seconds} 秒`;
			if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
			return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
		}
		/** 芯片图标(内联 SVG)。 */
		function ChipIcon({ size = 16 }) {
			return React.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinejoin: "round"
			},
				React.createElement("rect", { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.5 }),
				React.createElement("rect", { x: 6, y: 6, width: 4, height: 4, rx: 0.5 }),
				React.createElement("path", { d: "M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" })
			);
		}
		/** 关闭图标。 */
		function CloseIcon({ size = 14 }) {
			return React.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round"
			},
				React.createElement("path", { d: "M4 4l8 8M12 4l-8 8" })
			);
		}
		/** 面板正文:状态/操作/参数/API 接入/日志。 */
		function MlxPanelBody(props) {
			const { view, busy, error, selected, setSelected, defaultModel, setDefaultModel, port, setPort, autoStart, setAutoStart, serveOnDemand, setServeOnDemand, thinkMode, setThinkMode, serverArgs, setServerArgs, showLog, setShowLog, onAction, onLoad, onCheckWeights } = props;
			const [copied, setCopied] = React.useState(false);
			const server = view?.server ?? {};
			const config = view?.config ?? {};
			const models = config.models ?? [];
			const state = server.state ?? "stopped";
			const running = state === "running";
			const busyDisabled = busy !== null;
			const activeModel = models.find((model) => model.id === server.modelId);
			const log = server.recentLog ?? [];
			const apiUrl = `http://${server.host ?? "127.0.0.1"}:${server.port ?? 8080}/v1`;
			const copyApi = () => {
				navigator.clipboard?.writeText(apiUrl).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}).catch(() => {});
			};
			return React.createElement(React.Fragment, null,
				React.createElement("div", { className: "mlx-row" },
					React.createElement("span", { className: "mlx-meta" },
						`当前模型: ${activeModel === undefined ? (server.modelRepo ?? "—") : `${activeModel.name} (${activeModel.repo})`}`,
						server.pid !== null && server.pid !== undefined ? ` · pid ${server.pid}` : "",
						` · ${server.host ?? "127.0.0.1"}:${server.port ?? 8080}`,
						server.uptimeSec !== null && server.uptimeSec !== undefined ? ` · 已运行 ${uptimeText(server.uptimeSec)}` : "",
						server.adopted === true ? " · 已接管上次遗留的服务" : ""
					)
				),
				React.createElement("div", { className: "mlx-row" },
					React.createElement("select", {
						className: "mlx-select",
						value: selected,
						disabled: busyDisabled,
						// 下拉展开前触发一次权重检测(刷新 status 的 weightAvailable)
						onFocus: () => onCheckWeights(),
						onClick: () => onCheckWeights(),
						onChange: (event) => setSelected(event.target.value)
					}, models.map((model) =>
						React.createElement("option", {
							key: model.id,
							value: model.id,
							disabled: model.weightAvailable === false
						},
							`${model.name ?? model.id}${model.id === server.modelId ? " ●" : ""}${model.weightAvailable === false ? " (权重缺失)" : ""}`
						)
					)),
					React.createElement("button", {
						type: "button",
						className: "mlx-btn mlx-btn-primary",
						disabled: busyDisabled || running,
						onClick: () => onAction("start", api.start(selected === "" ? undefined : selected, undefined))
					}, busy === "start" ? "启动中…" : "启动"),
					React.createElement("button", {
						type: "button",
						className: "mlx-btn mlx-btn-danger",
						disabled: busyDisabled || (state !== "running" && state !== "starting"),
						onClick: () => onAction("stop", api.stop())
					}, busy === "stop" ? "停止中…" : "停止"),
					React.createElement("button", {
						type: "button",
						className: "mlx-btn",
						disabled: busyDisabled || selected === "" || selected === server.modelId || state === "starting",
						onClick: () => onAction("switch", api.switchModel(selected))
					}, busy === "switch" ? "切换中…" : "切换")
				),
				React.createElement("div", { className: "mlx-section" },
					React.createElement("p", { className: "mlx-sectionTitle" }, "API 接入(OpenAI 兼容)"),
					React.createElement("div", { className: "mlx-row" },
						React.createElement("code", { className: "mlx-api" }, apiUrl),
						React.createElement("button", {
							type: "button",
							className: "mlx-btn",
							disabled: busyDisabled,
							onClick: copyApi
						}, copied ? "已复制" : "复制")
					),
					React.createElement("p", { className: "mlx-hint" },
						"本插件已注册 LLM 提供者 mlx-local:在 设置 → 模型 中可直接选择本地模型,发起推理时自动启动/切换服务。也可继续使用“自定义提供方”:route 名任意(如 local-mlx),协议选 openai-completions,baseURL 填以上地址。API Key 必填但可填任意值(如 local,本地服务不校验)。"
					)
				),
				React.createElement("div", { className: "mlx-section" },
					React.createElement("p", { className: "mlx-sectionTitle" }, "参数"),
					React.createElement("div", { className: "mlx-fieldRow" },
						React.createElement("label", { className: "mlx-label" }, "默认模型",
							React.createElement("select", {
								className: "mlx-select",
								value: defaultModel,
								onChange: (event) => setDefaultModel(event.target.value)
							},
								React.createElement("option", { value: "" }, "(无)"),
								models.map((model) =>
									React.createElement("option", {
										key: model.id,
										value: model.id,
										disabled: model.weightAvailable === false
									}, model.name ?? model.id)
								)
							)
						),
						React.createElement("label", { className: "mlx-label" }, "端口",
							React.createElement("input", {
								className: "mlx-input",
								type: "number",
								min: 1,
								max: 65535,
								value: port,
								onChange: (event) => setPort(event.target.value)
							})
						),
						React.createElement("label", { className: "mlx-label" }, "思考模式",
							React.createElement("select", {
								className: "mlx-select",
								value: thinkMode,
								onChange: (event) => setThinkMode(event.target.value)
							},
								React.createElement("option", { value: "auto" }, "自动(模型默认,通常开)"),
								React.createElement("option", { value: "on" }, "开启思考"),
								React.createElement("option", { value: "off" }, "关闭思考")
							)
						),
						React.createElement("label", { className: "mlx-label" },
							React.createElement("input", {
								type: "checkbox",
								checked: autoStart,
								onChange: (event) => setAutoStart(event.target.checked)
							}), "随 DSH 启动自动拉起服务"
						),
						React.createElement("label", { className: "mlx-label" },
							React.createElement("input", {
								type: "checkbox",
								checked: serveOnDemand,
								onChange: (event) => setServeOnDemand(event.target.checked)
							}), "按需启动/切换服务(选择 mlx-local 模型时)"
						)
					),
					React.createElement("div", { className: "mlx-fieldRow" },
						React.createElement("button", {
							type: "button",
							className: "mlx-btn",
							disabled: busyDisabled,
							onClick: () => onLoad()
						}, busy === "load" ? "加载中…" : "加载模型…"),
						React.createElement("span", { className: "mlx-hint" },
							"从本地目录添加模型(不自动启动);下拉展开时会自动检测各模型权重是否存在"
						)
					),
					React.createElement("div", { className: "mlx-fieldRow" },
						React.createElement("label", { className: "mlx-label mlx-input-wide" }, "附加参数(逗号分隔)",
							React.createElement("input", {
								className: "mlx-input mlx-input-wide",
								type: "text",
								placeholder: "如 --max-kv-size,4096",
								value: serverArgs,
								onChange: (event) => setServerArgs(event.target.value)
							})
						),
						React.createElement("button", {
							type: "button",
							className: "mlx-btn",
							disabled: busyDisabled,
							onClick: () => onAction("save", api.setConfig({
								defaultModel,
								port: Number(port),
								autoStart,
								serveOnDemand,
								thinkMode,
								serverArgs: serverArgs.trim() === "" ? [] : serverArgs.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
							}))
						}, busy === "save" ? "保存中…" : "保存参数")
					),
					React.createElement("p", { className: "mlx-hint" },
						"“加载模型…”打开目录选择器添加并启动本地模型;端口/思考模式/附加参数在下次启动服务时生效。"
					)
				),
				React.createElement("div", { className: "mlx-section" },
					React.createElement("button", {
						type: "button",
						className: "mlx-btn",
						disabled: busyDisabled,
						onClick: () => setShowLog(!showLog)
					}, showLog ? "收起日志" : "查看最近日志"),
					showLog ? React.createElement("pre", { className: "mlx-log" },
						log.length === 0 ? "(暂无日志)" : log.slice(-12).join("\n")
					) : null
				),
				error === null ? null : React.createElement("p", { className: "mlx-error" }, error)
			);
		}
		/** 侧边栏底部按钮 + 浮动面板(自包含)。 */
		function MlxSection({ pickDirectory }) {
			const [view, setView] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [selected, setSelected] = React.useState("");
			const [defaultModel, setDefaultModel] = React.useState("");
			const [port, setPort] = React.useState("");
			const [autoStart, setAutoStart] = React.useState(false);
			const [serveOnDemand, setServeOnDemand] = React.useState(true);
			const [thinkMode, setThinkMode] = React.useState("auto");
			const [serverArgs, setServerArgs] = React.useState("");
			const [showLog, setShowLog] = React.useState(false);
			// 表单字段只在首次加载时用服务端配置初始化;之后轮询只刷新
			// 状态/日志,绝不覆盖用户正在编辑(未保存)的值。
			const initialized = React.useRef(false);
			const refresh = React.useCallback((signal) => {
				return api.status(signal).then((value) => {
					setView(value);
					setError(null);
					if (!initialized.current) {
						initialized.current = true;
						const config = value.config ?? {};
						const models = config.models ?? [];
						const active = value.server?.modelId;
						setSelected(active || config.defaultModel || (models[0]?.id ?? ""));
						setDefaultModel(config.defaultModel || "");
						setPort(String(config.port ?? 8080));
						setAutoStart(Boolean(config.autoStart));
						setServeOnDemand(config.serveOnDemand !== false);
						setThinkMode(config.thinkMode ?? "auto");
						setServerArgs((config.serverArgs ?? []).join(", "));
					}
				}).catch((failure) => {
					setError(failure?.message ?? String(failure));
				});
			}, []);
			React.useEffect(() => {
				let alive = true;
				const controller = new AbortController();
				refresh(controller.signal);
				const timer = setInterval(() => {
					if (alive) refresh(controller.signal);
				}, 5000);
				return () => {
					alive = false;
					clearInterval(timer);
					controller.abort();
				};
			}, [refresh]);
			const onAction = React.useCallback(async (name, promise) => {
				setBusy(name);
				setError(null);
				try {
					await promise;
					await refresh();
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				} finally {
					setBusy(null);
				}
			}, [refresh]);
			// 加载模型:打开目录选择器 → 提交本地路径 → host 校验并加入列表(不启动)
			const onLoad = React.useCallback(async () => {
				setBusy("load");
				setError(null);
				try {
					const path = await pickDirectory();
					if (typeof path !== "string" || path.length === 0) throw new Error("未选择目录");
					await api.load(path);
					await refresh();
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				} finally {
					setBusy(null);
				}
			}, [pickDirectory, refresh]);
			// 下拉展开前:自动检测权重,缺失的模型直接从列表删除(host 持久化)
			const onCheckWeights = React.useCallback(() => {
				api.prune().catch(() => {}).then(() => refresh());
			}, [refresh]);
			const state = view?.server?.state ?? "stopped";
			const dotClass = state === "running" ? "mlx-dot-running" : state === "starting" ? "mlx-dot-starting" : "mlx-dot-stopped";
			const portInUse = view?.server?.portInUse === true;
			return React.createElement("div", { className: "mlx-page" },
				React.createElement("div", { className: "mlx-head" },
					React.createElement(ChipIcon, { size: 16 }),
					"MLX 模型服务",
					React.createElement("span", { className: "mlx-badge" },
						React.createElement("span", { className: `mlx-dot ${dotClass}` }),
						stateText(state)
					)
				),
				portInUse ? React.createElement("p", { className: "mlx-warn" },
					"检测到端口上有残留的 MLX 服务进程(可能是之前异常退出留下的,会占用内存)。",
					React.createElement("button", {
						type: "button",
						className: "mlx-btn mlx-btn-danger",
						disabled: busy !== null,
						onClick: () => onAction("recover", api.recover())
					}, busy === "recover" ? "回收中…" : "回收残留服务")
				) : null,
				React.createElement("div", { className: "mlx-body" },
					view === null ?
						React.createElement("p", { className: "mlx-hint" }, error === null ? "加载中…" : error) :
						React.createElement(MlxPanelBody, {
							view, busy, error,
							selected, setSelected,
							defaultModel, setDefaultModel,
							port, setPort,
							autoStart, setAutoStart,
							serveOnDemand, setServeOnDemand,
							thinkMode, setThinkMode,
							serverArgs, setServerArgs,
							showLog, setShowLog,
							onAction,
							onLoad,
							onCheckWeights
						})
				)
			);
		}
		//#endregion

		//#region 浏览器插件入口
		/** 浏览器端注入的服务。 */
		const inject = ["slots", "workspaces"];
		/** 注册为设置页左侧菜单栏目(通用设置=0,模型=10,插件=15 之间)。 */
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mlx-local",
				order: 12,
				label: () => "MLX 模型",
				inject: () => ({
					pickDirectory: () => ctx.workspaces.pickDirectory()
				})
			}, MlxSection));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
