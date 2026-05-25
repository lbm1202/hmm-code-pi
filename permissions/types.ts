// Shared types for the permission system.

import type { ModeName } from "../config";

export type Verdict = "allow" | "ask" | "deny";

/** Per-tool rule table. Keys are glob patterns (see ./glob.ts). */
export type Ruleset = Record<string, Verdict>;

/** A complete permission config — what one layer (defaults / global / project)
 *  contributes. Merging multiple layers is done at evaluation time. */
export interface Permissions {
	/** Per-tool path-pattern rules. Tool keys: read/edit/write/bash. */
	rules?: Partial<Record<ToolKey, Ruleset>>;
	/** Patterns for paths OUTSIDE the workspace cwd. */
	external_directory?: Ruleset;
	/** Per-mode override layer (merged after this layer's own fields). */
	modes?: Partial<Record<ModeName, Permissions>>;
}

/** Tool kinds the permission system reasons about. Other tools (grep, find,
 *  ls) inherit the `read` ruleset since they all consume file paths. */
export type ToolKey = "read" | "edit" | "write" | "bash";

/** Decision returned by the evaluator. */
export interface Decision {
	verdict: Verdict;
	/** Human-readable reason — surfaced in tool result on block, or shown in
	 *  the confirm dialog on ask. */
	reason: string;
}
