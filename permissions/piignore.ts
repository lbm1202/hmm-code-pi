// .piignore parser. Same syntax as .gitignore (subset we actually need):
//   - blank lines + `#` comments → skip
//   - leading `!` → negation (allowlist override)
//   - trailing `/` → directory-only
//   - patterns are matched against workspace-relative paths
//
// Returns a function that takes a workspace-relative path and reports whether
// it should be blocked. Block semantics: if any non-negated rule matches AND
// no later negation un-matches it, the path is blocked.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { matches } from "./glob";

interface Rule {
	pattern: string;
	negate: boolean;
	dirOnly: boolean;
}

function parseRules(content: string): Rule[] {
	const out: Rule[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		let pattern = line;
		let negate = false;
		if (pattern.startsWith("!")) {
			negate = true;
			pattern = pattern.slice(1);
		}
		let dirOnly = false;
		if (pattern.endsWith("/")) {
			dirOnly = true;
			pattern = pattern.slice(0, -1);
		}
		// gitignore semantics: pattern with no slash matches at any depth.
		// Approximate by adding a `**/` variant so `*.log` catches `a/b.log`.
		const expandeds = pattern.includes("/")
			? [pattern]
			: [pattern, "**/" + pattern];
		for (const p of expandeds) {
			out.push({ pattern: p, negate, dirOnly });
			// For dir-only rules also match files INSIDE the directory.
			if (dirOnly) out.push({ pattern: p + "/**", negate, dirOnly: false });
		}
	}
	return out;
}

export interface Ignore {
	isBlocked(relPath: string, isDir?: boolean): boolean;
	hasRules(): boolean;
}

const EMPTY: Ignore = {
	isBlocked: () => false,
	hasRules: () => false,
};

const cache = new Map<string, { mtime: number; ignore: Ignore }>();

/** Load `${cwd}/.piignore` if present, with mtime-based cache so repeated
 *  evaluations during one tool call don't re-parse the file. */
export function loadIgnore(cwd: string | undefined): Ignore {
	if (!cwd) return EMPTY;
	const path = join(cwd, ".piignore");
	if (!existsSync(path)) return EMPTY;
	let mtime: number;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		return EMPTY;
	}
	const cached = cache.get(path);
	if (cached && cached.mtime === mtime) return cached.ignore;
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return EMPTY;
	}
	const rules = parseRules(content);
	const ignore: Ignore = {
		hasRules: () => rules.length > 0,
		isBlocked(rel, isDir) {
			let blocked = false;
			for (const r of rules) {
				if (r.dirOnly && isDir === false) continue;
				if (!matches(r.pattern, rel)) continue;
				blocked = !r.negate;
			}
			return blocked;
		},
	};
	cache.set(path, { mtime, ignore });
	return ignore;
}
