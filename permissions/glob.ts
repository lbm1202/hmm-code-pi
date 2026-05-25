// Lightweight glob matcher used by the permission system. We don't need the
// full minimatch surface — just enough to evaluate user-supplied patterns
// against tool paths and bash commands.
//
// Supported tokens:
//   *     any chars within a single path segment (no `/`)
//   **    any chars including `/`
//   ?     single char (not `/`)
//   [abc] character class
//   ~/    home directory expansion (only when pattern starts with `~/`)
//
// Everything else is a literal. No brace expansion, no negation (`!`) — the
// permission system represents intent (allow/ask/deny) via the value, not
// pattern prefix.

import { homedir } from "node:os";

const HOME = homedir().replace(/\\/g, "/");

/** Expand `~/` at the start of a path. Idempotent for non-home patterns. */
export function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return HOME + p.slice(1);
	return p;
}

/** Convert a glob pattern to a RegExp. Anchored at both ends. */
function patternToRegex(pattern: string): RegExp {
	const expanded = expandHome(pattern);
	let re = "^";
	let i = 0;
	while (i < expanded.length) {
		const c = expanded[i];
		if (c === "*") {
			if (expanded[i + 1] === "*") {
				// `**` matches any chars including /
				re += ".*";
				i += 2;
				// Eat a following `/` so `**/foo` and `**foo` both work.
				if (expanded[i] === "/") i++;
			} else {
				// `*` matches any chars except /
				re += "[^/]*";
				i++;
			}
			continue;
		}
		if (c === "?") {
			re += "[^/]";
			i++;
			continue;
		}
		if (c === "[") {
			// Character class — copy until `]`. If unmatched, treat as literal.
			const end = expanded.indexOf("]", i + 1);
			if (end < 0) {
				re += "\\[";
				i++;
			} else {
				re += expanded.slice(i, end + 1);
				i = end + 1;
			}
			continue;
		}
		// Regex special chars that need escaping
		if (/[.+^$()|{}\\]/.test(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
		i++;
	}
	re += "$";
	return new RegExp(re);
}

const regexCache = new Map<string, RegExp>();
function regexFor(pattern: string): RegExp {
	let r = regexCache.get(pattern);
	if (!r) {
		r = patternToRegex(pattern);
		regexCache.set(pattern, r);
	}
	return r;
}

/** Test whether `subject` matches `pattern`. Both are normalized to forward
 *  slashes before matching so Windows backslashes don't break anything. */
export function matches(pattern: string, subject: string): boolean {
	const s = subject.replace(/\\/g, "/");
	return regexFor(pattern).test(s);
}

/** Find the LAST matching rule in `rules` (insertion-order Map) for `subject`.
 *  Returns the matched key+value, or undefined if no rule matches.
 *  "Last-match wins" mirrors Kilo's evaluation semantics. */
export function lastMatch<T>(
	rules: Record<string, T> | undefined,
	subject: string,
): { pattern: string; value: T } | undefined {
	if (!rules) return undefined;
	let hit: { pattern: string; value: T } | undefined;
	for (const [pattern, value] of Object.entries(rules)) {
		if (matches(pattern, subject)) hit = { pattern, value };
	}
	return hit;
}
