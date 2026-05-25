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

/** Convert a glob pattern to a RegExp. Anchored at both ends.
 *  `pathMode = true`: file-path semantics — `*` is one segment (no `/`).
 *  `pathMode = false`: shell-command / general semantics — `*` matches anything. */
function patternToRegex(pattern: string, pathMode: boolean): RegExp {
	const expanded = expandHome(pattern);
	const STAR = pathMode ? "[^/]*" : ".*";
	const QMARK = pathMode ? "[^/]" : ".";
	let re = "^";
	let i = 0;
	while (i < expanded.length) {
		const c = expanded[i];
		if (c === "*") {
			if (expanded[i + 1] === "*") {
				// `**` always matches any chars (including /)
				re += ".*";
				i += 2;
				// Eat a following `/` so `**/foo` and `**foo` both work.
				if (expanded[i] === "/") i++;
			} else {
				re += STAR;
				i++;
			}
			continue;
		}
		if (c === "?") {
			re += QMARK;
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

const regexCachePath = new Map<string, RegExp>();
const regexCacheShell = new Map<string, RegExp>();
function regexFor(pattern: string, pathMode: boolean): RegExp {
	const cache = pathMode ? regexCachePath : regexCacheShell;
	let r = cache.get(pattern);
	if (!r) {
		r = patternToRegex(pattern, pathMode);
		cache.set(pattern, r);
	}
	return r;
}

/** Test whether `subject` matches `pattern` as a file path. `*` won't cross
 *  `/` boundaries (use `**` for recursive). Subject is normalized to forward
 *  slashes so Windows backslashes don't break anything. */
export function matches(pattern: string, subject: string): boolean {
	const s = subject.replace(/\\/g, "/");
	return regexFor(pattern, true).test(s);
}

/** Test whether `subject` matches `pattern` as a shell command. `*` matches
 *  anything including `/` — `"rm *"` correctly catches `"rm /tmp/foo"`. */
export function matchesShell(pattern: string, subject: string): boolean {
	return regexFor(pattern, false).test(subject);
}

/** Find the LAST matching rule in `rules` for `subject` as a file path.
 *  Last-match wins (Kilo semantics). */
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

/** Same as `lastMatch` but uses shell-command matching semantics. */
export function lastMatchShell<T>(
	rules: Record<string, T> | undefined,
	subject: string,
): { pattern: string; value: T } | undefined {
	if (!rules) return undefined;
	let hit: { pattern: string; value: T } | undefined;
	for (const [pattern, value] of Object.entries(rules)) {
		if (matchesShell(pattern, subject)) hit = { pattern, value };
	}
	return hit;
}
