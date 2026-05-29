// Pull the file paths a tool will touch out of its arguments.
//
// Returns an array because some tools (multi_edit) operate on multiple files
// and we evaluate the rules per-path — a single denied file blocks the call.
//
// Path normalization: trim, drop `file://` prefixes, leave everything else
// alone (we don't resolve to absolute here — the evaluator does that with
// the workspace cwd).

export interface ToolPaths {
	/** Workspace-relative or absolute path strings that this tool touches. */
	paths: string[];
}

function asString(v: unknown): string {
	if (typeof v !== "string") return "";
	let s = v.trim();
	if (s.startsWith("file://")) s = s.slice(7);
	return s;
}

export function extractPaths(toolName: string, input: any): ToolPaths {
	switch (toolName) {
		case "read":
		case "ls":
		case "find": {
			const p = asString(input?.path ?? input?.file_path);
			return { paths: p ? [p] : [] };
		}
		case "grep": {
			// path is the SEARCH root — treat as read.
			const p = asString(input?.path ?? input?.glob);
			return { paths: p ? [p] : [] };
		}
		case "edit":
		case "write": {
			const p = asString(input?.path ?? input?.file_path);
			return { paths: p ? [p] : [] };
		}
		case "multi_edit": {
			// Pi's multi_edit and similar batch tools — collect every per-edit path.
			const arr = Array.isArray(input?.edits) ? input.edits : [];
			const set = new Set<string>();
			const root = asString(input?.path ?? input?.file_path);
			if (root) set.add(root);
			for (const e of arr) {
				const p = asString(e?.path ?? e?.file_path);
				if (p) set.add(p);
			}
			return { paths: [...set] };
		}
		default:
			return { paths: [] };
	}
}
