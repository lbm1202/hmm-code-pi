// Pure resolution of a mode's active tool set from its configured tools.
// Extracted from ModeState so the security-relevant invariant — edit/write are
// stripped from every non-code mode — is unit-testable without a live Pi.

import type { ModeName } from "./config";

/** edit/write are code-only — auto-stripped from plan/debug/ask. */
const PROTECTED_FROM_NON_CODE: ReadonlySet<string> = new Set(["edit", "write"]);
/** Tools every mode always gets, regardless of `activeTools`. */
const ALWAYS_INJECTED: readonly string[] = ["ask_user", "request_mode_switch"];

/** Resolve the effective active tools for a mode.
 *  - non-code modes lose edit/write (returned in `stripped` for a warning)
 *  - ask_user + request_mode_switch are always injected
 *  - plan/review also get finalize_plan (review uses it for fix-round plans);
 *    code gets finalize_implementation only when the session has a review
 *    target (parent plan session, or a plan finalized in this session) —
 *    standalone code sessions never see the tool; code/debug get todo_write
 *  - the result is filtered to tools Pi actually knows about (`allToolNames`) */
export function resolveActiveTools(
	name: ModeName,
	requested: string[],
	allToolNames: string[],
	hasReviewTarget = false,
): { tools: string[]; stripped: string[] } {
	let stripped: string[] = [];
	let base = requested;
	if (name !== "code") {
		stripped = requested.filter((t) => PROTECTED_FROM_NON_CODE.has(t));
		base = requested.filter((t) => !PROTECTED_FROM_NON_CODE.has(t));
	}
	const merged = [...base, ...ALWAYS_INJECTED];
	if (name === "plan" || name === "review") merged.push("finalize_plan");
	if (name === "code" && hasReviewTarget) merged.push("finalize_implementation");
	// Multi-step task list for execution modes (code/debug). Plan and ask don't
	// need it — plan uses finalize_plan, ask is conversational.
	if (name === "code" || name === "debug") merged.push("todo_write");
	const unique = [...new Set(merged)];
	const tools = unique.filter((t) => allToolNames.includes(t));
	return { tools, stripped };
}
