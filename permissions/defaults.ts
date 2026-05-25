// Built-in permission defaults. Two layers:
//   1. BASE_DEFAULTS — common rules applied for every mode.
//   2. MODE_DEFAULTS — per-mode overrides. plan/ask get the read-only bash
//      set; plan additionally allows writes only to its own plan files.

import type { ModeName } from "../config";
import { BASH_DEFAULT, BASH_READ_ONLY } from "./bash-rules";
import type { Permissions } from "./types";

export const BASE_DEFAULTS: Permissions = {
	rules: {
		read: {
			"*": "allow",
			"*.env": "ask",
			"*.env.*": "ask",
			"*.env.example": "allow",
		},
		edit: { "*": "allow" },
		write: { "*": "allow" },
		bash: BASH_DEFAULT,
	},
	external_directory: {
		// Anything outside the workspace cwd needs a confirm by default.
		"*": "ask",
		// Carve-outs for paths Pi/our extensions naturally touch — asking
		// every time we hit /tmp or ~/.pi would be unworkable.
		"/tmp/**": "allow",
		"~/.pi/**": "allow",
	},
};

/** Plan-mode allows edit/write ONLY to its own plan markdown files. Mirrors
 *  Kilo's plan agent rule that permits ".kilo/plans/*.md" + ".opencode/plans/*.md".
 *  Pi's finalize_plan writes to .pi/plans/, so that's our allowlist. */
const PLAN_WRITABLE: Record<string, "allow" | "deny" | "ask"> = {
	"*": "deny",
	".pi/plans/*.md": "allow",
	".pi/plans/**/*.md": "allow",
};

export const MODE_DEFAULTS: Record<ModeName, Permissions> = {
	code: {
		// Inherits base — full power.
	},
	plan: {
		rules: {
			bash: BASH_READ_ONLY,
			edit: PLAN_WRITABLE,
			write: PLAN_WRITABLE,
		},
	},
	debug: {
		// bash inherits base (debug needs free shell for tests/repro).
		// edit/write are blocked at activeTools (LLM never sees the tools),
		// so no path-layer rules needed.
	},
	ask: {
		rules: {
			bash: BASH_READ_ONLY,
			// Defense in depth — even if a future change adds edit/write to
			// ask's activeTools, the permission layer still denies.
			edit: { "*": "deny" },
			write: { "*": "deny" },
		},
	},
};
