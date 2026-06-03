import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES, type ModeConfig, type ModeName, type ModesFile } from "./config";
import { AUTO_COMPACT_THRESHOLD, MODE_STATE_ENTRY, STATUS_KEYS } from "./constants";
import { renderModeBox } from "./mode-box";
import { resolveActiveTools } from "./mode-tools";

// Footer box rendering + mode colors moved to mode-box.ts; re-export modeColor
// so existing `import { modeColor } from "./state"` sites (hooks.ts) still work.
export { modeColor } from "./mode-box";

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
	// Set true immediately before WE call ctx.compact() (turn_end/agent_end
	// policy, /compact command, VS Code button). The session_before_compact
	// hook reads it to tell our intentional compaction apart from Pi's built-in
	// auto trigger (which we suppress). Consumed (cleared) by the hook.
	compactRequestedByUs = false;

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

	/** Optional auto-title system-prompt override (consumed by auto-title.ts).
	 *  Empty/unset → built-in language-aware default. */
	get autoTitlePromptOverride(): string | undefined {
		return this.modes.autoTitlePrompt;
	}

	/** Optional extra focus appended to the compaction prompt (consumed by
	 *  hooks.ts / commands.ts as customInstructions). */
	get compactInstructionsOverride(): string | undefined {
		return this.modes.compactInstructions;
	}

	/** Optional model override for context compaction (consumed by hooks.ts). */
	get compactModelOverride(): { provider: string; id: string } | undefined {
		return this.modes.compactModel;
	}

	/** Effective auto-compact trigger percent: modes.json override or the
	 *  built-in default. */
	get autoCompactThreshold(): number {
		return this.modes.autoCompactThreshold ?? AUTO_COMPACT_THRESHOLD;
	}

	/** Dynamic compaction on/off (default on). On → preserve the agent's
	 *  multi-step turn, compact at the boundary. Off → legacy cut-and-compact
	 *  the moment the threshold is crossed. */
	get dynamicCompaction(): boolean {
		return this.modes.dynamicCompaction ?? true;
	}

	/** Whether to keep OLD tool-call outputs in the model context verbatim
	 *  (default false → prune them to a notice past a recent-output window; the
	 *  full output stays in the on-disk transcript). */
	get includeOldToolOutputs(): boolean {
		return this.modes.includeOldToolOutputs ?? false;
	}

	computeActiveTools(name: ModeName, allToolNames: string[]): { tools: string[]; stripped: string[] } {
		return resolveActiveTools(name, this.configFor(name).activeTools ?? [], allToolNames);
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
		this.pi.appendEntry(MODE_STATE_ENTRY, { mode: name });
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
		return renderModeBox({
			mode: this.current,
			modelLabel: this.modelLabel(),
			thinkingLevel: this.pi.getThinkingLevel(),
			autoApprove: this.autoApprove,
			overridden: this.isAnyOverridden(),
			width,
			info,
		});
	}

	/** Whether the interactive editor is wired. False in RPC mode before the
	 *  editor component is created (and in pure-headless runs). */
	hasEditor(): boolean {
		const submit = (this.editorInstance as { onSubmit?: unknown } | undefined)?.onSubmit;
		return typeof submit === "function";
	}

	/** Fake-submit a slash command by driving the editor's onSubmit. This is the
	 *  only way extension code can run a command like /reload or /plan-execute:
	 *  pi.sendUserMessage skips the slash-command path (expandPromptTemplates is
	 *  false there). Returns false if the editor isn't available. */
	submitSlash(cmd: string): boolean {
		const editor = this.editorInstance;
		const submit = (editor as { onSubmit?: (s: string) => void } | undefined)?.onSubmit;
		if (typeof submit !== "function") return false;
		try {
			submit.call(editor, cmd);
			return true;
		} catch (err) {
			console.error(`[modes] submitSlash(${cmd}) failed:`, err);
			return false;
		}
	}

	restoreFromSession(ctx: ExtensionContext): ModeName {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === MODE_STATE_ENTRY,
			)
			.pop() as { data?: { mode?: ModeName } } | undefined;
		const restored = last?.data?.mode;
		if (restored && MODE_NAMES.includes(restored)) return restored;
		return this.modes.defaultMode ?? "code";
	}
}
