// Core rule evaluation. Given a tool call, walk every permission layer (base
// defaults → mode defaults → global user → project user), pick the strongest
// applicable verdict for the tool's paths/command, and surface a decision
// the hook can act on.
//
// "Strongest" precedence: deny > ask > allow. So if any layer denies, deny.
// Within a single layer, last-match-wins (Kilo semantics) — captured by
// glob.ts:lastMatch.

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ModeName } from "../config";
import { lastMatch, lastMatchShell } from "./glob";
import type { Decision, Permissions, Ruleset, ToolKey, Verdict } from "./types";

const VERDICT_RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

function strongest(a: Verdict, b: Verdict): Verdict {
	return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/** Map a Pi tool name to the ToolKey we evaluate rules under.
 *  grep/find/ls inherit `read` since they all consume file paths. */
function toolKeyFor(toolName: string): ToolKey {
	switch (toolName) {
		case "edit":
		case "multi_edit":
			return "edit";
		case "write":
			return "write";
		case "bash":
			return "bash";
		default:
			return "read";
	}
}

/** Collect rulesets for a given tool key from every layer, in order. */
function rulesetsForLayer(p: Permissions | undefined, key: ToolKey): Ruleset[] {
	if (!p) return [];
	const out: Ruleset[] = [];
	const r = p.rules?.[key];
	if (r) out.push(r);
	return out;
}

function externalRulesetFor(p: Permissions | undefined): Ruleset | undefined {
	return p?.external_directory;
}

/** Is `target` outside the workspace `cwd`? */
function isExternal(target: string, cwd: string): boolean {
	if (!isAbsolute(target)) return false;
	const rel = relative(cwd, target);
	// `..` prefix or absolute output means outside cwd.
	return rel.startsWith("..") || isAbsolute(rel);
}

/** Normalize a path to what rules expect: workspace-relative if inside cwd,
 *  absolute otherwise. */
function normalize(target: string, cwd: string): string {
	if (!isAbsolute(target)) return target.replace(/\\/g, "/");
	if (isExternal(target, cwd)) return target.replace(/\\/g, "/");
	return relative(cwd, target).replace(/\\/g, "/") || ".";
}

const HOME = homedir().replace(/\\/g, "/");

/** Resolve an extracted path to an absolute, lexically-normalized form against
 *  the workspace cwd. Expands a leading `~/`, then makes the path absolute and
 *  collapses `.`/`..` segments. This MUST run before rule evaluation: without
 *  it a relative escape like `../../../etc/passwd` is never seen as absolute,
 *  so the `external_directory` gate is skipped and the path matches the in-cwd
 *  `read: { "**": "allow" }` rule — a silent sandbox bypass. `~/.ssh/id_rsa`
 *  has the same problem (treated as a literal relative path) until expanded.
 *
 *  We deliberately do NOT realpath()-resolve symlinks: on macOS the canonical
 *  form of `/tmp` is `/private/tmp`, which would break the `/tmp/**: allow`
 *  carve-out in defaults.ts, and realpath adds TOCTOU. Lexical resolution
 *  closes the exploitable relative-escape hole; symlink hardening is a
 *  separate, carve-out-aware change. */
export function canonicalize(raw: string, cwd: string): string {
	let p = raw.replace(/\\/g, "/");
	if (p === "~") p = HOME;
	else if (p.startsWith("~/")) p = HOME + p.slice(1);
	return resolve(cwd, p).replace(/\\/g, "/");
}

export interface EvaluateInput {
	toolName: string;
	mode: ModeName;
	cwd: string;
	/** File paths the tool will touch (extract-paths.ts). May be empty for bash. */
	paths: string[];
	/** Full bash command string when toolName === "bash". */
	bashCommand?: string;
	/** Layered permission sources (lowest → highest precedence). */
	layers: Permissions[];
}

/** Evaluate one (toolName, target) combo against all layers + their per-mode
 *  override slots. Returns the strongest verdict found, or "allow" as the
 *  ultimate default. `pathMode = false` switches to shell-command matching
 *  so `"rm *"` in BASH_DEFAULT correctly catches `"rm /tmp/foo"`. */
function evaluateOne(
	input: EvaluateInput,
	subject: string,
	key: ToolKey,
	pathMode = true,
): Verdict {
	const matcher = pathMode ? lastMatch : lastMatchShell;
	let v: Verdict = "allow";
	for (const layer of input.layers) {
		for (const rs of rulesetsForLayer(layer, key)) {
			const hit = matcher(rs, subject);
			if (hit) v = strongest(v, hit.value);
		}
		const modeLayer = layer.modes?.[input.mode];
		for (const rs of rulesetsForLayer(modeLayer, key)) {
			const hit = matcher(rs, subject);
			if (hit) v = strongest(v, hit.value);
		}
	}
	return v;
}

function evaluateExternal(input: EvaluateInput, abs: string): Verdict {
	let v: Verdict = "allow";
	for (const layer of input.layers) {
		const own = externalRulesetFor(layer);
		if (own) {
			const hit = lastMatch(own, abs);
			if (hit) v = strongest(v, hit.value);
		}
		const modeLayer = layer.modes?.[input.mode];
		const modeExt = externalRulesetFor(modeLayer);
		if (modeExt) {
			const hit = lastMatch(modeExt, abs);
			if (hit) v = strongest(v, hit.value);
		}
	}
	return v;
}

export function evaluate(input: EvaluateInput): Decision {
	const key = toolKeyFor(input.toolName);

	// Bash: match the full command against the bash ruleset (shell-mode `*`
	// covers `/`), then ALSO extract absolute paths from the command and run
	// them through the external_directory layer. Without this, `bash "cat
	// /etc/passwd"` would only check the bash rules — and our bash rules
	// don't know anything about /etc, /private, ~/.ssh, etc.
	if (key === "bash") {
		const cmd = input.bashCommand ?? "";
		let v = evaluateOne(input, cmd, "bash", /* pathMode */ false);
		let externalSubject = "";
		for (const raw of extractAbsolutePathsFromBash(cmd, input.cwd)) {
			// Collapse `..` before matching so `/tmp/../../etc/passwd` can't ride
			// the `/tmp/**: allow` carve-out to reach an external path.
			const abs = canonicalize(raw, input.cwd);
			if (!isExternal(abs, input.cwd)) continue;
			const ext = evaluateExternal(input, abs);
			const combined = strongest(v, ext);
			if (VERDICT_RANK[combined] > VERDICT_RANK[v]) {
				v = combined;
				externalSubject = abs;
			}
		}
		return {
			verdict: v,
			reason:
				v === "allow"
					? ""
					: externalSubject
						? `bash command touches external ${externalSubject} (${v === "deny" ? "denied" : "needs approval"}): ${truncate(cmd, 80)}`
						: `bash command ${v === "deny" ? "denied" : "needs approval"}: ${truncate(cmd, 120)}`,
		};
	}

	// Path-based tools: every path must pass. Strongest wins overall.
	if (input.paths.length === 0) return { verdict: "allow", reason: "" };

	let worst: Verdict = "allow";
	let worstSubject = "";
	for (const raw of input.paths) {
		// Resolve to an absolute, dot-collapsed path first so a relative escape
		// (`../../etc/passwd`) reaches the external_directory layer below.
		const abs = canonicalize(raw, input.cwd);
		const subject = normalize(abs, input.cwd);
		const pathVerdict = evaluateOne(input, subject, key);
		// External directory layer (independent of read/edit/write ruleset)
		let extVerdict: Verdict = "allow";
		if (isExternal(abs, input.cwd)) {
			extVerdict = evaluateExternal(input, abs);
		}
		const combined = strongest(pathVerdict, extVerdict);
		if (VERDICT_RANK[combined] > VERDICT_RANK[worst]) {
			worst = combined;
			worstSubject = subject;
		}
	}

	return {
		verdict: worst,
		reason:
			worst === "allow"
				? ""
				: `${input.toolName} on ${worstSubject} ${worst === "deny" ? "denied" : "needs approval"}`,
	};
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Heuristically pull absolute path tokens from a bash command so the
 *  external_directory layer gets a chance to evaluate them. Catches `/abs`,
 *  `~/path` (expanded), and quoted forms. Misses paths built via vars or
 *  command substitution — those are the LLM's responsibility to declare. */
function extractAbsolutePathsFromBash(cmd: string, cwd: string): string[] {
	const out = new Set<string>();
	const home = process.env.HOME ?? "";
	// Match optionally-quoted tokens starting with / or ~/ — stop at whitespace,
	// quote, or shell metachars that would never appear inside a real path.
	const re = /(?:^|[\s=:])["']?(~?\/[^\s"'`<>|;&)\]]+)/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
	while ((m = re.exec(cmd)) !== null) {
		let p = m[1];
		if (p.startsWith("~/") && home) p = home + p.slice(1);
		// Strip trailing punctuation that's almost certainly not part of the path.
		p = p.replace(/[.,:;]+$/, "");
		if (p.length > 1) out.add(p);
	}
	void cwd; // cwd reserved for future relative-resolution; out is absolute-only
	return [...out];
}
