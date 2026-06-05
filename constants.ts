// Single source of truth for cross-module string keys & magic numbers.
// Centralizing here lets the VS Code extension's RPC bridge stay in lock-step
// (see VS Code ext ANALYSIS §6 — setStatus keys are part of the public contract).

import { readFileSync } from "node:fs";

/** ctx.ui.setStatus keys emitted by this extension. The VS Code companion
 *  (hmm-code-vscode) mirrors this set in webview/protocol.ts — keep in sync. */
export const STATUS_KEYS = {
	MODE: "mode",
	MODEL: "model",
	THINKING: "thinking",
	OVERRIDDEN: "overridden",
	CONTEXT: "context",
	PLAN_HANDOFF: "plan-handoff",
	TODOS: "todos",
	AUTO_APPROVE: "auto-approve",
} as const;

/** Auto-compact triggers at this context-usage percent. Pi's built-in
 * reserveTokens trigger is ~94% on large windows — too late for comfort. */
export const AUTO_COMPACT_THRESHOLD = 70;

/** Dynamic-compaction grace band. In dynamic mode the agent's multi-step turn
 * is NOT cut at the threshold; compaction waits for the turn boundary
 * (agent_end). The only mid-loop force-compact is when usage climbs this many
 * percent past the threshold — an overflow-safety cap. With dynamic compaction
 * ON the threshold is capped at 80 (so threshold + gap ≤ 90, clear of 100 —
 * compacting at ~100% is pointless); with it OFF there's no grace band (compaction
 * happens AT the threshold), so the threshold may go up to 90. */
export const DYNAMIC_COMPACT_GAP = 10;

/** Hard ceiling for the mid-loop force-compact / Pi-built-in passthrough point.
 * Keeps a little headroom below the real context window so a genuine overflow
 * (which reads ~100%) still falls through to a compaction instead of being
 * suppressed. hardCap = min(threshold + DYNAMIC_COMPACT_GAP, this). */
export const COMPACT_HARDCAP_MAX = 95;

/** Default timeout (seconds) injected into bash tool calls that don't specify
 *  one. The bash tool has NO default timeout, so a non-terminating foreground
 *  command — an interactive TUI app, a dev server, a watcher — would hang the
 *  turn forever. 2 minutes is generous for normal dev commands (installs,
 *  builds, test suites); the model can still pass a longer explicit timeout. */
export const DEFAULT_BASH_TIMEOUT_SEC = 120;

/** Built-in auto-title system prompt (base, WITHOUT the language line — that's
 *  appended at runtime from HMM_CODE_LANG and is always enforced). Single-line
 *  literal so the VS Code settings panel can parse it as the editable default.
 *  Keep it one line. */
export const DEFAULT_AUTO_TITLE_PROMPT = "You generate a very short (3–7 words) descriptive title summarizing what the user is trying to do. Respond with ONLY the title — no quotes, no markdown, no preamble, no trailing punctuation.";

/** Session custom-entry type that records the active mode. Written when a mode
 *  is applied (state.ts) and when a plan handoff pre-seeds a new session
 *  (commands.ts); read back on restore (state.ts). */
export const MODE_STATE_ENTRY = "mode-state";

/** Models whose thinking is binary (on/off) rather than leveled. */
export const BINARY_THINKING_FORMATS = new Set(["qwen-chat-template", "qwen", "zai"]);

/** Version string for the banner, sourced from package.json (sibling of this
 *  module) so it can't drift out of sync with the published release — it had,
 *  for several releases, while a hand-maintained literal here read v0.1.0.
 *  Fail-soft: a read failure falls back rather than breaking extension load. */
function readExtVersion(): string {
	try {
		const { version } = JSON.parse(
			readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
		) as { version?: string };
		return version ? `v${version}` : "v?";
	} catch {
		return "v?";
	}
}

/** Banner shown at session start (TUI only). Mixed-case "Hmm" matches the
 *  logo (capital H + lowercase x-height m's). The lowercase glyphs in ui.ts
 *  leave row 0 empty so they sit at x-height next to the cap. */
export const BANNER_TEXT = "Hmm";
export const EXT_VERSION = readExtVersion();
export const AUTHOR = "lbm1202";
export const BANNER_RGB: [number, number, number] = [95, 255, 95]; // LED green
