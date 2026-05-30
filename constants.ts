// Single source of truth for cross-module string keys & magic numbers.
// Centralizing here lets the VS Code extension's RPC bridge stay in lock-step
// (see VS Code ext ANALYSIS §6 — setStatus keys are part of the public contract).

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
export const AUTO_COMPACT_THRESHOLD = 75;

/** Dynamic-compaction grace band. In dynamic mode the agent's multi-step turn
 * is NOT cut at the threshold; compaction waits for the turn boundary
 * (agent_end). The only mid-loop force-compact is when usage climbs this many
 * percent past the threshold — an overflow-safety cap. The user-facing
 * threshold is limited to [50, 85] so threshold + gap never exceeds 100. */
export const DYNAMIC_COMPACT_GAP = 15;

/** Hard ceiling for the mid-loop force-compact / Pi-built-in passthrough point.
 * Keeps a little headroom below the real context window so a genuine overflow
 * (which reads ~100%) still falls through to a compaction instead of being
 * suppressed. hardCap = min(threshold + DYNAMIC_COMPACT_GAP, this). */
export const COMPACT_HARDCAP_MAX = 95;

/** Built-in auto-title system prompt (base, WITHOUT the language line — that's
 *  appended at runtime from HMM_CODE_LANG and is always enforced). Single-line
 *  literal so the VS Code settings panel can parse it as the editable default.
 *  Keep it one line. */
export const DEFAULT_AUTO_TITLE_PROMPT = "You generate a very short (3–7 words) descriptive title summarizing what the user is trying to do. Respond with ONLY the title — no quotes, no markdown, no preamble, no trailing punctuation.";

/** Models whose thinking is binary (on/off) rather than leveled. */
export const BINARY_THINKING_FORMATS = new Set(["qwen-chat-template", "qwen", "zai"]);

/** Banner shown at session start (TUI only). Mixed-case "Hmm" matches the
 *  logo (capital H + lowercase x-height m's). The lowercase glyphs in ui.ts
 *  leave row 0 empty so they sit at x-height next to the cap.
 *
 *  When bumping EXT_VERSION, also bump `version` in package.json. */
export const BANNER_TEXT = "Hmm";
export const EXT_VERSION = "v0.1.0";
export const AUTHOR = "lbm1202";
export const BANNER_RGB: [number, number, number] = [95, 255, 95]; // LED green
