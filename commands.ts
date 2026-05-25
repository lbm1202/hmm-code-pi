// /mode, /mode-set, /plan-execute, /reset slash commands.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES, type ModeName } from "./config";
import { BINARY_THINKING_FORMATS } from "./constants";
import { updateModeConfigField } from "./config-io";
import { findLatestPlan } from "./plans";
import type { Runtime } from "./runtime";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function registerCommands(rt: Runtime): void {
	const { pi, state } = rt;

	pi.registerCommand("mode", {
		description: "Switch active mode (plan/code/debug/ask)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg) {
				if (!MODE_NAMES.includes(arg as ModeName)) {
					ctx.ui.notify(`Unknown mode "${arg}". Available: ${MODE_NAMES.join(", ")}`, "error");
					return;
				}
				if (arg === state.current) {
					ctx.ui.notify(`Already in ${arg} mode`, "info");
					return;
				}
				await state.apply(arg as ModeName, ctx);
				return;
			}

			const labels = MODE_NAMES.map((m) => (m === state.current ? `${m} (current)` : m));
			const choice = await ctx.ui.select("Switch mode to:", labels);
			if (choice == null) return;
			const picked = choice.replace(" (current)", "") as ModeName;
			if (picked === state.current) {
				ctx.ui.notify(`Already in ${picked} mode`, "info");
				return;
			}
			await state.apply(picked, ctx);
		},
	});

	pi.registerCommand("mode-set", {
		description: "Configure modes (model + thinking) — edit multiple, auto-reload on exit",
		handler: async (_args, ctx) => modeSetHandler(rt, ctx),
	});

	pi.registerCommand("plan-execute", {
		description: "Launch the most recent plan in a new session",
		handler: async (_args, ctx) => planExecuteHandler(rt, ctx),
	});

	pi.registerCommand("reset", {
		description: "Reset model + thinking to the current mode's defaults",
		handler: async (_args, ctx) => resetHandler(rt, ctx),
	});

	pi.registerCommand("reload-runtime", {
		description: "Reload extensions/keybindings/skills/themes + re-read models.json (RPC-safe).",
		handler: async (_args, ctx) => {
			try {
				// ctx.reload() refreshes settingsManager + extensions and emits
				// session_start(reason="reload") — our hooks.ts handler picks
				// that up and calls ctx.modelRegistry.refresh() with the fresh
				// post-reload ctx, so models.json edits become visible.
				await (ctx as any).reload?.();
				ctx.ui.notify("Reloaded extensions + settings + models.", "info");
			} catch (err) {
				ctx.ui.notify(`Reload failed: ${err}`, "error");
			}
		},
	});

	// /auto-approve — session-scoped binary toggle. Forms:
	//   /auto-approve         → toggle (default behavior)
	//   /auto-approve on      → force on
	//   /auto-approve off     → force off
	// Never persisted to disk by design — making "on" the permanent default
	// would defeat the permission system. For a permanent rule edit
	// ~/.pi/agent/permissions.json directly.
	pi.registerCommand("auto-approve", {
		description: "Toggle session bypass for permission ask prompts",
		handler: async (args, ctx) => autoApproveHandler(rt, ctx, args),
	});
}

/** Handler exported so the VS Code button can drive the same code path. */
export async function autoApproveHandler(
	rt: Runtime,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	const { state } = rt;
	const tok = (args ?? "").trim().toLowerCase();
	const next =
		tok === "on" || tok === "true" || tok === "1"
			? true
			: tok === "off" || tok === "false" || tok === "0"
				? false
				: !state.autoApprove;
	state.autoApprove = next;
	try {
		ctx.ui.setStatus("auto-approve", next ? "on" : "off");
	} catch {
		/* setStatus may not exist on every UI surface */
	}
	ctx.ui.notify(`auto-approve: ${next ? "ON" : "OFF"} (this session)`, "info");
}

/** Reset handler — shared by /reset and Alt+X (see shortcuts.ts). */
export async function resetHandler(rt: Runtime, ctx: ExtensionContext): Promise<void> {
	const { state } = rt;
	if (ctx.model) {
		state.currentModelId = ctx.model.id;
		state.currentModelProvider = (ctx.model as { provider?: string }).provider;
	}
	if (!state.isAnyOverridden()) {
		ctx.ui.notify(`Already on mode "${state.current}" defaults.`, "info");
		return;
	}
	const r = await state.resetToDefaults(ctx);
	if (r.error) {
		ctx.ui.notify(r.error, "error");
		return;
	}
	const parts: string[] = [];
	if (r.modelReset) {
		const ref = state.defaultModelRef();
		if (ref) parts.push(`model=${ref.provider}/${ref.id}`);
	}
	if (r.thinkingReset) {
		parts.push(`thinking=${state.defaultThinkingLevel()}`);
	}
	ctx.ui.notify(
		`Reset to mode "${state.current}" defaults${parts.length ? `: ${parts.join(", ")}` : ""}`,
		"info",
	);
}

async function modeSetHandler(rt: Runtime, ctx: ExtensionContext): Promise<void> {
	const { state } = rt;
	const DONE = "──── Done (save + reload) ────";
	const CANCEL = "──── Cancel (discard, no reload) ────";
	const EDIT_MODEL = "Edit model";
	const EDIT_THINKING = "Edit thinking level";
	const BACK = "Back";
	let dirty = false;

	outer: while (true) {
		const modeLabels = MODE_NAMES.map((name) => {
			const cfg = state.configFor(name);
			const m = cfg?.model;
			let modelStr = "(unset)";
			if (m && m !== "none" && typeof m === "object") {
				const full = `${m.provider}/${m.id}`;
				const alias = state.modelAliases[full] ?? state.modelAliases[m.id];
				modelStr = alias ? `${alias} (${m.id})` : full;
			}
			const lvl = cfg?.thinkingLevel ?? "(default)";
			return `${name}  │  model: ${modelStr}  │  thinking: ${lvl}`;
		});
		const topPick = await ctx.ui.select("Mode to configure:", [...modeLabels, DONE, CANCEL]);
		if (topPick == null || topPick === CANCEL) {
			ctx.ui.notify("mode-set cancelled.", "info");
			return;
		}
		if (topPick === DONE) break outer;
		const idx = modeLabels.indexOf(topPick);
		const modeName = MODE_NAMES[idx];
		if (!modeName) continue;

		while (true) {
			const sub = await ctx.ui.select(`Edit ${modeName}:`, [EDIT_MODEL, EDIT_THINKING, BACK]);
			if (sub == null || sub === BACK) break;
			if (sub === EDIT_MODEL) {
				dirty = (await editModeModel(rt, ctx, modeName)) || dirty;
			} else if (sub === EDIT_THINKING) {
				dirty = (await editModeThinking(rt, ctx, modeName)) || dirty;
			}
		}
	}

	if (!dirty) {
		ctx.ui.notify("No changes.", "info");
		return;
	}
	ctx.ui.notify("Saved. Reloading…", "info");
	setTimeout(() => triggerReload(rt), 200);
}

async function editModeModel(
	rt: Runtime,
	ctx: ExtensionContext,
	modeName: ModeName,
): Promise<boolean> {
	const available = (ctx.modelRegistry as any).getAvailable?.() ?? [];
	if (!Array.isArray(available) || available.length === 0) {
		ctx.ui.notify("No models with auth configured. Set up a provider first.", "error");
		return false;
	}
	const aliases = rt.state.modelAliases;
	const modelLabels = available.map((m: any) => {
		const full = `${m.provider}/${m.id}`;
		const alias = aliases[full] ?? aliases[m.id];
		return alias ? `${alias}  —  ${full}` : full;
	});
	const choice = await ctx.ui.select(`Model for ${modeName}:`, modelLabels);
	if (choice == null) return false;
	const mIdx = modelLabels.indexOf(choice);
	const model = available[mIdx];
	if (!model) return false;
	const r = updateModeConfigField(modeName, "model", { provider: model.provider, id: model.id });
	if (r.error) {
		ctx.ui.notify(`Failed: ${r.error}`, "error");
		return false;
	}
	return true;
}

async function editModeThinking(
	rt: Runtime,
	ctx: ExtensionContext,
	modeName: ModeName,
): Promise<boolean> {
	// Pi-standard supported-levels logic: include each level unless its
	// thinkingLevelMap entry is null. xhigh is included only when explicitly
	// mapped (not undefined). For binary thinking formats, collapse the picker
	// to off/on while still storing canonical level keys.
	let availableLevels: string[] = [...THINKING_LEVELS];
	let displayMap: Record<string, string> = {};
	const cfg = rt.state.configFor(modeName);
	const m = cfg?.model;
	if (m && m !== "none" && typeof m === "object") {
		const model = ctx.modelRegistry.find(m.provider, m.id) as any;
		if (model) {
			if (!model.reasoning) {
				availableLevels = ["off"];
			} else {
				const map = model.thinkingLevelMap ?? {};
				availableLevels = (THINKING_LEVELS as readonly string[]).filter((lvl) => {
					const mapped = map[lvl];
					if (mapped === null) return false;
					if (lvl === "xhigh") return mapped !== undefined;
					return true;
				});
			}
			const fmt = model?.compat?.thinkingFormat;
			if (fmt && BINARY_THINKING_FORMATS.has(fmt)) {
				const nonOff = availableLevels.filter((l) => l !== "off");
				if (nonOff.length >= 1) {
					displayMap = { off: "off", on: nonOff[0] as string };
					availableLevels = ["off", "on"];
				}
			}
		}
	}
	const display = await ctx.ui.select(`Thinking level for ${modeName}:`, availableLevels);
	if (display == null) return false;
	const choice = displayMap[display] ?? display;
	const r = updateModeConfigField(modeName, "thinkingLevel", choice);
	if (r.error) {
		ctx.ui.notify(`Failed: ${r.error}`, "error");
		return false;
	}
	return true;
}

async function planExecuteHandler(rt: Runtime, ctx: ExtensionContext): Promise<void> {
	const { state } = rt;
	let planPath = state.pendingPlanPath;
	const targetMode = state.pendingTargetMode ?? "code";
	if (!planPath) {
		planPath = findLatestPlan();
		if (!planPath) {
			ctx.ui.notify("No plan found in .pi/plans/. Call finalize_plan in plan mode first.", "error");
			return;
		}
	}

	// Reference the plan FILE rather than pasting the full text into the
	// editor. The new session's LLM reads the file itself via its Read tool.
	const body = [
		`You are now in ${targetMode.toUpperCase()} mode (handoff from plan). You are no longer read-only — edit/write/bash are available.`,
		"",
		`A plan was saved at ${planPath}. Read it first, then implement exactly what it specifies. Do not re-plan, expand scope, refactor adjacent code, or add features the plan did not ask for.`,
		"",
		`If the plan has a real gap (missing step, contradicts the code, wrong path), call request_mode_switch("plan", reason, summary) instead of improvising.`,
	].join("\n");

	const newSession = (ctx as { newSession?: Function }).newSession;
	if (typeof newSession !== "function") {
		ctx.ui.notify(
			"ctx.newSession unavailable in this Pi version. Use the current-session option from finalize_plan instead.",
			"error",
		);
		return;
	}

	const parentSession = ctx.sessionManager?.getSessionFile?.();
	const result = await (ctx as any).newSession({
		parentSession,
		// Seed the new session's mode via a mode-state entry written BEFORE
		// the new session's extension load. session_start picks it up.
		setup: async (sm: any) => {
			try {
				sm.appendCustomEntry("mode-state", { mode: targetMode });
			} catch (err) {
				console.error("[modes:commands] setup appendCustomEntry failed:", err);
			}
		},
		withSession: async (replacementCtx: any) => {
			const newFile = replacementCtx.sessionManager?.getSessionFile?.();
			replacementCtx.ui.notify(`New session: ${newFile ?? "(unknown file)"}`, "info");
			try {
				await replacementCtx.sendUserMessage(body);
			} catch (err) {
				// Fallback: prefill editor so user can submit manually.
				console.error("[modes:commands] auto sendUserMessage failed:", err);
				replacementCtx.ui.setEditorText(body);
				replacementCtx.ui.notify(`Auto-send failed (${err}). Press Enter to submit.`, "warning");
			}
		},
	});

	if (result?.cancelled) {
		ctx.ui.notify("New-session creation cancelled.", "warning");
		return;
	}
	state.pendingPlanPath = undefined;
	state.pendingTargetMode = undefined;
}

/** Simulate typing "/reload" into the editor — extension code can't call
 *  ctx.reload() but the editor's onSubmit routes through prompt() which
 *  recognises the slash prefix and runs the command. */
function triggerReload(rt: Runtime): void {
	const editor = rt.state.editorInstance ?? rt.editorInstance;
	const submit = (editor as { onSubmit?: (s: string) => void } | undefined)?.onSubmit;
	if (typeof submit === "function") {
		try {
			submit.call(editor, "/reload");
		} catch (err) {
			console.error("[modes:commands] auto /reload failed:", err);
		}
	}
}
