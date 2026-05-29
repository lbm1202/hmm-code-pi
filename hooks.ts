// Pi event subscriptions: provider-payload injection, system prompt addendum,
// session_start (header/footer/editor setup + initial mode apply), token/state
// invalidation, auto-compact at the threshold, and deferred plan dispatch.

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadModes, MODE_NAMES, type ModeName } from "./config";
import { writeExampleConfigIfMissing, ensureKeybindingsOverride, ensureQuietStartup } from "./config-io";
import { STATUS_KEYS } from "./constants";
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

	// Append the mode addendum + any AGENTS.md content to the agent's system
	// prompt. Re-evaluated each agent_start, so editing AGENTS.md mid-session
	// takes effect on the next user prompt without a reload.
	pi.on("before_agent_start", async (event, ctx) => {
		const addendum = state.config?.systemPromptAddendum;
		const agents = readAgentsMd(ctx?.cwd);
		if (!addendum && !agents) return;
		const sections = [event.systemPrompt];
		if (addendum) {
			sections.push(`## Active mode: ${state.current}\n${addendum}`);
		}
		if (agents) {
			// Project AGENTS.md overrides global where they overlap (LLMs follow
			// later instructions more closely than earlier ones), so emit
			// global first then project.
			if (agents.global) {
				sections.push(`## Global AGENTS.md (~/.pi/agent/AGENTS.md)\n${agents.global}`);
			}
			if (agents.project) {
				sections.push(`## Project AGENTS.md (${agents.projectPath})\n${agents.project}`);
			}
		}
		return { systemPrompt: sections.join("\n\n") };
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

		// Reset auto-approve on every session start. Carrying it across new
		// sessions (or even fork/switch) would silently grant blanket bypass
		// long after the user forgot they enabled it.
		state.autoApprove = false;
		try {
			ctx.ui.setStatus(STATUS_KEYS.AUTO_APPROVE, "off");
		} catch {
			/* setStatus may not exist on every UI surface */
		}

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
			setTimeout(() => state.submitSlash("/reload"), 500);
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

	// Compact-in-flight tracking with a watchdog. Without the watchdog, if
	// compact() returns but neither onComplete nor session_compact ever fires
	// (provider error swallowed inside Pi, a queued no-op, etc.), the flag stays
	// true forever and the turn_end guard below silently disables auto-compact
	// for the rest of the session — the exact late-trigger we're avoiding.
	let compactWatchdog: any;
	const armCompact = (): void => {
		state.compactInFlight = true;
		if (compactWatchdog) clearTimeout(compactWatchdog);
		compactWatchdog = setTimeout(() => {
			compactWatchdog = undefined;
			if (state.compactInFlight) {
				console.error("[modes:hooks] compact watchdog: no completion in 60s — re-arming auto-compact");
				state.compactInFlight = false;
			}
		}, 60_000);
		compactWatchdog?.unref?.();
	};
	const disarmCompact = (): void => {
		if (compactWatchdog) {
			clearTimeout(compactWatchdog);
			compactWatchdog = undefined;
		}
		state.compactInFlight = false;
	};

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

		// Sanitize toolCall names that violate OpenAI Responses API's strict
		// regex `^[a-zA-Z0-9_-]+$`. Local models (Qwen via vLLM, etc.) can
		// emit malformed XML/JSON tool calls where the LLM jams the whole
		// command into the `name` field — e.g. `"ls /Users/foo\n</parameter"`.
		// Pi happily stores these in the session jsonl. They round-trip fine
		// through tolerant providers (Anthropic, openai-completions), but the
		// moment the user switches to codex/openai-responses the whole session
		// hard-stucks: every subsequent request includes the bad name in
		// history and gets a 400. Replace with a sentinel here so Pi's normal
		// "tool not found" path runs (LLM sees the error and retries) and
		// the session stays codex-portable.
		let sanitized = false;
		try {
			const content = event.message?.content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part?.type !== "toolCall") continue;
					const name = (part as { name?: unknown }).name;
					if (typeof name !== "string") continue;
					if (/^[a-zA-Z0-9_-]+$/.test(name)) continue;
					const snippet = name.replace(/\s+/g, " ").slice(0, 80);
					console.error(
						`[modes:sanitize] invalid toolCall name '${snippet}${name.length > 80 ? "…" : ""}' → '_invalid_tool_call'`,
					);
					(part as { name: string }).name = "_invalid_tool_call";
					sanitized = true;
				}
			}
		} catch (err) {
			console.error("[modes:hooks] toolCall sanitize failed:", err);
		}

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

		// If we sanitized, return the mutated message so Pi persists the
		// cleaned version (not the original) to the session jsonl.
		if (sanitized) return { message: event.message };
	});

	// Auto-compact: bail at the threshold to avoid Pi's reserveTokens trigger
	// firing too late.
	pi.on("session_before_compact", async () => {
		armCompact();
	});
	pi.on("session_compact", async () => {
		disarmCompact();
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
		const threshold = state.autoCompactThreshold;
		if (typeof pct !== "number" || pct < threshold) return;
		armCompact();
		ctx2.ui.notify(
			`Auto-compacting at ${pct.toFixed(1)}% (threshold ${threshold}%)…`,
			"info",
		);
		try {
			(ctx2 as any).compact?.({
				onComplete: () => {
					disarmCompact();
					rt.invalidateFooter?.();
					rt.requestRender();
				},
			});
		} catch (err) {
			console.error("[modes:hooks] auto-compact call failed:", err);
			ctx2.ui.notify(`Auto-compact failed: ${err}`, "warning");
			disarmCompact();
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

/** Load AGENTS.md from the project cwd + ~/.pi/agent/ (global). Returns
 *  undefined if neither exists. Re-read on every call so editing the file
 *  mid-session takes effect on the next user prompt — small file, cheap. */
function readAgentsMd(cwd: string | undefined):
	| { project?: string; projectPath?: string; global?: string }
	| undefined {
	const result: { project?: string; projectPath?: string; global?: string } = {};
	if (cwd) {
		const p = join(cwd, "AGENTS.md");
		if (existsSync(p)) {
			try {
				result.project = readFileSync(p, "utf-8").trim();
				result.projectPath = p;
			} catch (err) {
				console.error(`[modes] failed to read ${p}:`, err);
			}
		}
	}
	const g = join(homedir(), ".pi", "agent", "AGENTS.md");
	if (existsSync(g)) {
		try {
			result.global = readFileSync(g, "utf-8").trim();
		} catch (err) {
			console.error(`[modes] failed to read ${g}:`, err);
		}
	}
	if (!result.project && !result.global) return undefined;
	return result;
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
		return editor;
	});
}
