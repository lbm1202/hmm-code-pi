// Pi event subscriptions: provider-payload injection, system prompt addendum,
// session_start (header/footer/editor setup + initial mode apply), token/state
// invalidation, auto-compact at the threshold, and deferred plan dispatch.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { loadModes, MODE_NAMES, type ModeName } from "./config";
import { writeExampleConfigIfMissing, ensureKeybindingsOverride, ensureQuietStartup } from "./config-io";
import { AUTO_COMPACT_THRESHOLD, STATUS_KEYS } from "./constants";
import { abbreviateCwd, ansi24, buildBannerLines, fmtTokens } from "./ui";
import { modeColor } from "./state";
import type { Runtime } from "./runtime";

export function registerHooks(rt: Runtime): void {
	const { pi, state } = rt;

	// Inject preserve_thinking=true whenever Pi sends enable_thinking=true
	// (Qwen-style chat_template_kwargs). No-op for non-Qwen providers.
	pi.on("before_provider_request", async (event) => {
		const payload = (event as { payload?: Record<string, unknown> }).payload;
		const cck = payload?.chat_template_kwargs as Record<string, unknown> | undefined;
		if (cck && cck.enable_thinking === true) cck.preserve_thinking = true;
	});

	// Mode-specific provider payload mutation: temperature + chat template.
	pi.on("before_provider_request", async (event) => {
		const cfg = state.config;
		const payload = (event as { payload?: Record<string, unknown> }).payload;
		if (!payload) return;
		if (cfg?.temperature !== undefined) payload.temperature = cfg.temperature;
		if (cfg?.chatTemplate !== undefined) payload.chat_template = cfg.chatTemplate;
	});

	// Append the mode addendum to the agent's system prompt.
	pi.on("before_agent_start", async (event) => {
		const addendum = state.config?.systemPromptAddendum;
		if (!addendum) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Active mode: ${state.current}\n${addendum}`,
		};
	});

	pi.on("session_start", async (event, ctx) => {
		// Clear scrollback so prior shell output doesn't bleed into Pi's UI.
		// Use isTTY (not ctx.hasUI): in RPC mode hasUI is true but stdout is a
		// pipe to the parent, so raw ANSI bytes would corrupt JSON lines.
		if (process.stdout.isTTY) {
			try {
				process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
			} catch {
				/* ignore */
			}
		}

		state.setModes(loadModes(ctx.cwd));
		writeExampleConfigIfMissing();

		// On reload, ctx.reload() refreshes settingsManager but NOT the
		// modelRegistry — its cache of custom models.json + dynamic provider
		// configs becomes stale. Explicit refresh here re-reads models.json
		// and reapplies provider configs (after ctx.reload's resetApiProviders
		// cleared them). Skip on cold-boot ("startup") since the registry's
		// constructor already calls loadModels.
		if ((event as any)?.reason === "reload") {
			try {
				(ctx as any).modelRegistry?.refresh?.();
			} catch (err) {
				console.error("[modes:hooks] modelRegistry.refresh failed:", err);
			}
		}

		const kb = ensureKeybindingsOverride();
		const qs = ensureQuietStartup();
		if (kb.updated || qs.updated) {
			ctx.ui.notify(
				`modes: wrote ${[kb.updated && "keybindings", qs.updated && "settings"]
					.filter(Boolean)
					.join(" + ")}. Auto-reloading to apply…`,
				"info",
			);
			// editor isn't created yet at this point — defer until setEditorComponent
			// runs later in this same session_start handler.
			setTimeout(() => {
				const editor = state.editorInstance;
				const submit = (editor as { onSubmit?: (s: string) => void } | undefined)?.onSubmit;
				if (typeof submit === "function") {
					try {
						submit.call(editor, "/reload");
					} catch (err) {
						console.error("[modes:hooks] auto /reload failed:", err);
					}
				}
			}, 500);
		}

		if (ctx.hasUI) {
			setupHeaderFooter(rt, ctx);
			setupRuntimeHooks(rt);
			setupEditor(rt, ctx);
		}

		const flag = pi.getFlag("mode");
		const initial =
			typeof flag === "string" && MODE_NAMES.includes(flag as ModeName)
				? (flag as ModeName)
				: state.restoreFromSession(ctx);
		await state.apply(initial, ctx);
	});
}

function setupHeaderFooter(rt: Runtime, ctx: any): void {
	const { state } = rt;
	const cwdLabel = abbreviateCwd(ctx.cwd);

	ctx.ui.setHeader(() => ({
		render: (width: number) => buildBannerLines(width),
		invalidate: () => {},
	}));

	let cachedFooterLines: string[] | undefined;
	let lastWidth = 0;

	const buildInfo = (footerData: any): string[] => {
		// Sync cached model info to LIVE active model — single source of truth.
		if (ctx.model) {
			state.currentModelId = ctx.model.id;
			state.currentModelProvider = (ctx.model as { provider?: string }).provider;
		}
		const branch = footerData?.getGitBranch?.() ?? undefined;

		// Token usage aggregation from session entries.
		let tIn = 0;
		let tOut = 0;
		try {
			for (const entry of ctx.sessionManager.getEntries() as any[]) {
				if (
					entry?.type === "message" &&
					entry.message?.role === "assistant" &&
					entry.message?.usage
				) {
					const u = entry.message.usage;
					tIn += u.input ?? 0;
					tOut += u.output ?? 0;
				}
			}
		} catch (err) {
			console.error("[modes:hooks] footer token aggregation failed:", err);
		}

		let pct = 0;
		let ctxWindow = 0;
		try {
			const usage = (ctx as any).getContextUsage?.();
			ctxWindow = usage?.contextWindow ?? (ctx.model as any)?.contextWindow ?? 0;
			pct = typeof usage?.percent === "number" ? usage.percent : 0;
		} catch (err) {
			console.error("[modes:hooks] footer context usage read failed:", err);
		}
		const ctxLabel = `${pct.toFixed(1)}%/${fmtTokens(ctxWindow)}`;

		// Always render every cell (zero values OK) — keeps box width stable
		// as totals grow.
		return [
			`P ${fmtTokens(tIn)}`,
			`T ${fmtTokens(tOut)}`,
			ctxLabel,
			branch ? `${cwdLabel} (${branch})` : cwdLabel,
		];
	};

	ctx.ui.setFooter((_tui: any, _theme: any, footerData: any) => ({
		render: (width: number) => {
			if (cachedFooterLines && width === lastWidth) return cachedFooterLines;
			lastWidth = width;
			cachedFooterLines = state.renderBox(width, buildInfo(footerData));
			return cachedFooterLines;
		},
		invalidate: () => {
			cachedFooterLines = undefined;
		},
	}));

	rt.invalidateFooter = () => {
		cachedFooterLines = undefined;
	};
}

function setupRuntimeHooks(rt: Runtime): void {
	const { pi, state } = rt;

	// Model swaps from /model, /preset, etc. → refresh footer + status.
	pi.on("model_select", async (event: any, ctxMs: any) => {
		const newId = event?.model?.id ?? event?.id;
		const newProvider = event?.model?.provider ?? event?.provider;
		if (typeof newId === "string") state.currentModelId = newId;
		if (typeof newProvider === "string") state.currentModelProvider = newProvider;
		rt.invalidateFooter?.();
		rt.requestRender();
		if (ctxMs) state.pushStatus(ctxMs);
	});

	// Thinking level changes from ANY source (Alt+T, /preset, other extensions).
	pi.on("thinking_level_select", async (_e: any, ctxTl: any) => {
		rt.invalidateFooter?.();
		rt.requestRender();
		if (ctxTl) state.pushStatus(ctxTl);
	});

	// Refresh footer (token counts) on assistant messages. Also detect
	// silent model changes: Pi may fall back to a different model when the
	// configured one's auth disappears (e.g. user deletes openai-codex from
	// auth.json mid-session) without firing model_select. Compare ctx.model
	// against our cached id and re-push status so the VS Code picker pill
	// reflects the fallback immediately instead of waiting for /reload.
	pi.on("message_end", async (event: any, ctxMe: any) => {
		if (event?.message?.role !== "assistant") return;
		try {
			const liveId = ctxMe?.model?.id;
			const liveProvider = (ctxMe?.model as { provider?: string } | undefined)?.provider;
			if (
				typeof liveId === "string" &&
				(liveId !== state.currentModelId || liveProvider !== state.currentModelProvider)
			) {
				state.currentModelId = liveId;
				state.currentModelProvider = liveProvider;
				state.pushStatus(ctxMe);
			}
		} catch (err) {
			console.error("[modes:hooks] message_end model-sync failed:", err);
		}
		rt.invalidateFooter?.();
		rt.requestRender();
	});

	// Auto-compact: bail at the threshold to avoid Pi's reserveTokens trigger
	// firing too late.
	pi.on("session_before_compact", async () => {
		state.compactInFlight = true;
	});
	pi.on("session_compact", async () => {
		state.compactInFlight = false;
		rt.invalidateFooter?.();
		rt.requestRender();
	});

	pi.on("turn_end", async (_event: any, ctx2: any) => {
		// Single read of context usage per turn — used for both RPC status
		// push and the auto-compact threshold check.
		let usage: { percent?: number; contextWindow?: number } | undefined;
		try {
			usage = (ctx2 as any).getContextUsage?.();
		} catch (err) {
			console.error("[modes:hooks] turn_end getContextUsage failed:", err);
		}
		const pct = usage?.percent;
		if (typeof pct === "number") {
			try {
				ctx2.ui.setStatus(STATUS_KEYS.CONTEXT, `${pct.toFixed(1)}%`);
			} catch (err) {
				console.error("[modes:hooks] turn_end setStatus failed:", err);
			}
		}
		if (state.compactInFlight) return;
		if (typeof pct !== "number" || pct < AUTO_COMPACT_THRESHOLD) return;
		state.compactInFlight = true;
		ctx2.ui.notify(
			`Auto-compacting at ${pct.toFixed(1)}% (threshold ${AUTO_COMPACT_THRESHOLD}%)…`,
			"info",
		);
		try {
			(ctx2 as any).compact?.({
				onComplete: () => {
					state.compactInFlight = false;
					rt.invalidateFooter?.();
					rt.requestRender();
				},
			});
		} catch (err) {
			console.error("[modes:hooks] auto-compact call failed:", err);
			ctx2.ui.notify(`Auto-compact failed: ${err}`, "warning");
			state.compactInFlight = false;
		}
	});

	// Deferred message dispatch (current-session plan handoff + mode-switch
	// carry-over). Both stash a body and rely on a fresh runPromptMessages →
	// new createLoopConfig to pick up the post-apply model/activeTools/
	// systemPrompt. A same-loop deliverAs:"followUp" would reuse the
	// pre-apply config and the model would end up with stale tools.
	pi.on("agent_end", async () => {
		// Plan body wins if both are set (shouldn't happen, but be deterministic).
		const body = state.pendingCurrentSessionPlanBody ?? state.pendingModeSwitchMessage;
		if (!body) return;
		state.pendingCurrentSessionPlanBody = undefined;
		state.pendingModeSwitchMessage = undefined;
		setImmediate(() => {
			try {
				pi.sendUserMessage(body);
			} catch (err) {
				console.error("[modes:hooks] deferred dispatch failed:", err);
			}
		});
	});
}

function setupEditor(rt: Runtime, ctx: any): void {
	const { state } = rt;
	// Pi's interactive-mode.js wipes newEditor.borderColor with the default
	// editor's borderColor right after setEditorComponent runs (interactive-
	// mode.js:1726-1727). defineProperty with a no-op setter makes Pi's reset
	// silently fail and our getter always returns the current-mode color.
	ctx.ui.setEditorComponent((tui: any, theme: any, kb2: any) => {
		const editor = new (CustomEditor as any)(tui, theme, kb2);
		Object.defineProperty(editor, "borderColor", {
			get: () => (str: string) => ansi24(str, modeColor(state.current)),
			set: () => {
				/* swallow Pi's reset to defaultEditor.borderColor */
			},
			configurable: true,
		});
		state.editorInstance = editor;
		rt.editorInstance = editor;
		return editor;
	});
}
