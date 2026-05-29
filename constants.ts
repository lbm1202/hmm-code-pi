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
