import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES, type ModeConfig, type ModeName, type ModesFile } from "./config";
import { STATUS_KEYS } from "./constants";

const PROTECTED_FROM_NON_CODE: ReadonlySet<string> = new Set(["edit", "write"]);
const ALWAYS_INJECTED: readonly string[] = ["ask_user", "request_mode_switch"];

const MODE_COLORS: Record<ModeName, [number, number, number]> = {
	plan: [100, 150, 255], // blue
	code: [240, 240, 240], // white
	debug: [180, 120, 220], // purple
	ask: [255, 165, 80], // orange
};
const ANSI_RESET = "\x1b[0m";
// max name length + 1 → 2 of 4 names get perfect centering (code/plan with len 4),
// ask/debug end up 1 cell off. Pure-center for all 4 isn't possible with monospace
// when name lengths have mixed parity.
const MODE_FIELD_WIDTH = Math.max(...MODE_NAMES.map((n) => n.length)) + 1;

function ansi24(text: string, [r, g, b]: [number, number, number]): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

function centerText(text: string, width: number): string {
	const diff = Math.max(0, width - text.length);
	const left = Math.floor(diff / 2);
	const right = diff - left;
	return " ".repeat(left) + text + " ".repeat(right);
}

export function modeColor(name: ModeName): [number, number, number] {
	return MODE_COLORS[name];
}

export class ModeState {
	current: ModeName = "code";
	currentModelId: string | undefined;
	currentModelProvider: string | undefined;
	pendingPlanPath: string | undefined;
	pendingTargetMode: "code" | "debug" | undefined;
	/**
	 * Plan body to dispatch via pi.sendUserMessage AFTER the current agent loop
	 * exits. Used by finalize_plan's current-session branch instead of queuing
	 * during streaming: Pi's loop captures model in createLoopConfig once per
	 * runPromptMessages call, so follow-up queue items in the SAME loop run
	 * with the PRE-finalize_plan model. Dispatching post-agent_end starts a
	 * fresh loop that picks up the post-apply model.
	 */
	pendingCurrentSessionPlanBody: string | undefined;
	/**
	 * Carry-over message to dispatch AFTER agent loop exits. Same reason as
	 * pendingCurrentSessionPlanBody: request_mode_switch changes activeTools/
	 * systemPrompt/model via state.apply, but a same-loop deliverAs:"followUp"
	 * would still run with PRE-switch config. Stash here and dispatch from
	 * agent_end so the fresh loop reads the post-switch state.
	 */
	pendingModeSwitchMessage: string | undefined;
	onApply?: () => void;
	editorInstance: any;
	/**
	 * Auto-approve toggle for the permission system. When true, any "ask"
	 * verdict from the evaluator passes through without a confirm dialog.
	 * Session-scoped — reset on every session_start. Toggled via the
	 * /auto-approve slash command (CLI) or the inline button in the
	 * VS Code chat footer.
	 */
	autoApprove = false;
	// Auto-compact bookkeeping: avoid retriggering while one is in flight.
	compactInFlight = false;

	/** Mode's configured default model, or undefined if mode has no default. */
	defaultModelRef(): { provider: string; id: string } | undefined {
		const m = this.configFor(this.current)?.model;
		if (!m || m === "none" || typeof m !== "object") return undefined;
		return m;
	}

	/** Mode's configured default thinking level, or undefined if not set. */
	defaultThinkingLevel(): string | undefined {
		return this.configFor(this.current)?.thinkingLevel;
	}

	/** Whether the active model differs from the current mode's default. */
	isModelOverridden(): boolean {
		const ref = this.defaultModelRef();
		if (!ref) return false;
		return ref.provider !== this.currentModelProvider || ref.id !== this.currentModelId;
	}

	/** Whether the active thinking level differs from the current mode's default. */
	isThinkingOverridden(): boolean {
		const def = this.defaultThinkingLevel();
		if (!def) return false;
		return this.pi.getThinkingLevel() !== def;
	}

	/** Either model or thinking is currently overridden (for Alt+X cell display). */
	isAnyOverridden(): boolean {
		return this.isModelOverridden() || this.isThinkingOverridden();
	}

	/** Reset model + thinking to the current mode's defaults. */
	async resetToDefaults(
		ctx: ExtensionContext,
	): Promise<{ modelReset: boolean; thinkingReset: boolean; error?: string }> {
		let modelReset = false;
		let thinkingReset = false;
		const ref = this.defaultModelRef();
		if (ref && this.isModelOverridden()) {
			const model = ctx.modelRegistry.find(ref.provider, ref.id);
			if (!model) {
				return {
					modelReset,
					thinkingReset,
					error: `Default model ${ref.provider}/${ref.id} not in registry.`,
				};
			}
			const ok = await this.pi.setModel(model);
			if (!ok) {
				return {
					modelReset,
					thinkingReset,
					error: `setModel returned false for ${ref.provider}/${ref.id}.`,
				};
			}
			this.currentModelId = ref.id;
			this.currentModelProvider = ref.provider;
			modelReset = true;
		}
		const lvl = this.defaultThinkingLevel();
		if (lvl && this.isThinkingOverridden()) {
			this.pi.setThinkingLevel(lvl as any);
			thinkingReset = true;
		}
		return { modelReset, thinkingReset };
	}
	private modes: ModesFile = { defaultMode: "code", modes: {} as Record<ModeName, ModeConfig> };

	constructor(private readonly pi: ExtensionAPI) {}

	setModes(modes: ModesFile) {
		this.modes = modes;
	}

	configFor(name: ModeName): ModeConfig {
		return this.modes.modes[name];
	}

	get config(): ModeConfig {
		return this.configFor(this.current);
	}

	/** Read-only access to the user-configured model alias map (modes.json:modelAliases). */
	get modelAliases(): Record<string, string> {
		return this.modes.modelAliases ?? {};
	}

	/** Optional auto-title model override (modes.json:autoTitle). */
	get autoTitleOverride(): { provider: string; id: string } | undefined {
		return this.modes.autoTitle;
	}

	computeActiveTools(name: ModeName, allToolNames: string[]): { tools: string[]; stripped: string[] } {
		const cfg = this.configFor(name);
		const requested = cfg.activeTools ?? [];
		let stripped: string[] = [];
		let base = requested;
		if (name !== "code") {
			stripped = requested.filter((t) => PROTECTED_FROM_NON_CODE.has(t));
			base = requested.filter((t) => !PROTECTED_FROM_NON_CODE.has(t));
		}
		const merged = [...base, ...ALWAYS_INJECTED];
		if (name === "plan") merged.push("finalize_plan");
		// Multi-step task list for execution modes (code/debug). Plan and ask
		// don't need it — plan uses finalize_plan, ask is conversational.
		if (name === "code" || name === "debug") merged.push("todo_write");
		const unique = [...new Set(merged)];
		const tools = unique.filter((t) => allToolNames.includes(t));
		return { tools, stripped };
	}

	async apply(name: ModeName, ctx: ExtensionContext): Promise<void> {
		if (!MODE_NAMES.includes(name)) {
			ctx.ui.notify(`Unknown mode: ${name}`, "error");
			return;
		}
		const cfg = this.configFor(name);

		let appliedModelId: string | undefined;
		if (cfg.model && cfg.model !== "none" && typeof cfg.model === "object") {
			const ref = cfg.model;
			const model = ctx.modelRegistry.find(ref.provider, ref.id);
			if (model) {
				const ok = await this.pi.setModel(model);
				if (ok) appliedModelId = (model as { id?: string }).id ?? ref.id;
			} else {
				ctx.ui.notify(
					`Mode "${name}": model ${ref.provider}/${ref.id} not found in registry`,
					"warning",
				);
			}
		}

		if (cfg.thinkingLevel) {
			this.pi.setThinkingLevel(cfg.thinkingLevel);
		}

		const allToolNames = this.pi.getAllTools().map((t) => t.name);
		const { tools, stripped } = this.computeActiveTools(name, allToolNames);
		this.pi.setActiveTools(tools);

		if (stripped.length > 0) {
			ctx.ui.notify(
				`Mode "${name}": stripped restricted tools (${stripped.join(", ")}) — write/edit are code-only.`,
				"warning",
			);
		}

		this.current = name;
		// Prefer the model we just successfully applied; ctx.model is stale
		// because ctx was captured before pi.setModel() executed.
		this.currentModelId = appliedModelId ?? ctx.model?.id;
		const cfgModel = cfg.model;
		this.currentModelProvider =
			appliedModelId && cfgModel && cfgModel !== "none" && typeof cfgModel === "object"
				? cfgModel.provider
				: ctx.model?.provider;
		this.pi.appendEntry("mode-state", { mode: name });
		this.updateStatus(ctx);
	}

	updateStatus(ctx: ExtensionContext) {
		// Box is rendered by the footer component (see index.ts setFooter).
		// onApply triggers footer invalidate + a UI re-render so it picks up
		// the new mode/model immediately.
		this.onApply?.();
		this.pushStatus(ctx);
	}

	/**
	 * Push mode/model/thinking to ctx.ui.setStatus. In TUI this updates Pi's
	 * builtin status bar (we ignore it since we render our own footer). In RPC
	 * mode it becomes extension_ui_set_status hints so external clients
	 * (e.g. the VS Code extension) can mirror the state.
	 */
	/** Display label for the live model — alias from modes.json if present,
	 * else `provider/id`, else `id`, else "—". Used by pushStatus + footer. */
	modelLabel(): string {
		if (!this.currentModelId) return "—";
		const full = this.currentModelProvider
			? `${this.currentModelProvider}/${this.currentModelId}`
			: this.currentModelId;
		const alias = this.modes.modelAliases?.[full];
		if (alias) return alias;
		// Also try just the id (helps when alias dict is keyed by id only).
		const aliasById = this.modes.modelAliases?.[this.currentModelId];
		return aliasById ?? full;
	}

	pushStatus(ctx: ExtensionContext) {
		try {
			ctx.ui.setStatus(STATUS_KEYS.MODE, this.current);
			ctx.ui.setStatus(STATUS_KEYS.MODEL, this.modelLabel());
			const tl = this.pi.getThinkingLevel?.();
			if (tl !== undefined) ctx.ui.setStatus(STATUS_KEYS.THINKING, String(tl));
			// Authoritative "is the current model/thinking different from the
			// mode's configured defaults?" signal — clients use it to show/hide
			// a "reset to defaults" button.
			ctx.ui.setStatus(STATUS_KEYS.OVERRIDDEN, this.isAnyOverridden() ? "1" : "0");
		} catch {
			/* setStatus may not exist on every Pi UI surface — best-effort. */
		}
	}

	renderBox(width: number, info: string[]): string[] {
		const rgb = MODE_COLORS[this.current];
		const white: [number, number, number] = [240, 240, 240];

		// Box 1: open-left mode trough + model cell, optionally + auto-approve
		// and override hint cells. Colored per mode. Optional cells are dropped
		// when the terminal is too narrow to fit them alongside box2 (token
		// info) — essential cells (mode/model/thinking) always render.
		const centered = centerText(this.current, MODE_FIELD_WIDTH);
		const modeInner = ` ${centered} `;
		const modelInner = ` ${this.modelLabel()} `;
		const thinkingLevel = this.pi.getThinkingLevel();
		const thinkingInner = ` ${thinkingLevel} `;

		// Pre-build box2 so we know its width when deciding which box1 cells fit.
		const cells = info.filter((s) => s && s.length > 0).map((s) => ` ${s} `);
		const buildBox = (innerCells: string[]) => {
			const dashes = innerCells.map((c) => "─".repeat(c.length));
			return {
				top: `┌${dashes.join("┬")}┐`,
				mid: `│${innerCells.join("│")}│`,
				bot: `└${dashes.map((d) => d).join("┴")}┘`,
				width: dashes.reduce((n, d) => n + d.length, 0) + dashes.length + 1,
			};
		};
		let box2: { top: string; mid: string; bot: string; width: number } | undefined;
		if (cells.length > 0) box2 = buildBox(cells);

		const usable = Math.max(0, width - 1); // -1 for Pi's hardcoded 1-col padding
		const minGap = 2;

		// Try most-detailed box1, fall back progressively if too wide for box2.
		const candidates = [
			[modeInner, modelInner, thinkingInner, this.autoApprove ? " auto-approve " : "", this.isAnyOverridden() ? " Alt+X → default " : ""].filter((c) => c.length > 0),
			[modeInner, modelInner, thinkingInner, this.autoApprove ? " ✓auto " : "", this.isAnyOverridden() ? " ✱ " : ""].filter((c) => c.length > 0),
			[modeInner, modelInner, thinkingInner],
		];
		let box1Cells = candidates[0];
		for (const cand of candidates) {
			const w = cand.reduce((n, c) => n + c.length, 0) + cand.length;
			if (!box2 || w + box2.width + minGap <= usable) {
				box1Cells = cand;
				break;
			}
		}
		const box1Dashes = box1Cells.map((c) => "─".repeat(c.length));
		const box1Top = `${box1Dashes.join("┬")}┐`;
		const box1Mid = `${box1Cells.join("│")}│`;
		const box1Bot = `${box1Dashes.join("┴")}┘`;
		const box1Width = box1Top.length;

		if (!box2) {
			return [ansi24(box1Top, rgb), ansi24(box1Mid, rgb), ansi24(box1Bot, rgb)];
		}

		// If even the minimal box1 + box2 + min gap doesn't fit, drop box2
		// rather than letting them overlap. Box1 has the essential state.
		if (box1Width + box2.width + minGap > usable) {
			return [ansi24(box1Top, rgb), ansi24(box1Mid, rgb), ansi24(box1Bot, rgb)];
		}

		// Right-align box2: spacer fills the gap between box1 and the right edge.
		const gap = " ".repeat(Math.max(minGap, usable - box1Width - box2.width));

		return [
			ansi24(box1Top, rgb) + gap + ansi24(box2.top, white),
			ansi24(box1Mid, rgb) + gap + ansi24(box2.mid, white),
			ansi24(box1Bot, rgb) + gap + ansi24(box2.bot, white),
		];
	}

	restoreFromSession(ctx: ExtensionContext): ModeName {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "mode-state",
			)
			.pop() as { data?: { mode?: ModeName } } | undefined;
		const restored = last?.data?.mode;
		if (restored && MODE_NAMES.includes(restored)) return restored;
		return this.modes.defaultMode ?? "code";
	}
}
