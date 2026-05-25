// Core rule evaluation. Given a tool call, walk every permission layer (base
// defaults → mode defaults → global user → project user), pick the strongest
// applicable verdict for the tool's paths/command, and surface a decision
// the hook can act on.
//
// "Strongest" precedence: deny > ask > allow. So if any layer denies, deny.
// Within a single layer, last-match-wins (Kilo semantics) — captured by
// glob.ts:lastMatch.

import { isAbsolute, relative } from "node:path";
import type { ModeName } from "../config";
import { lastMatch } from "./glob";
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
 *  ultimate default. */
function evaluateOne(input: EvaluateInput, subject: string, key: ToolKey): Verdict {
	let v: Verdict = "allow";
	for (const layer of input.layers) {
		// Layer's own rules
		for (const rs of rulesetsForLayer(layer, key)) {
			const hit = lastMatch(rs, subject);
			if (hit) v = strongest(v, hit.value);
		}
		// Layer's mode override
		const modeLayer = layer.modes?.[input.mode];
		for (const rs of rulesetsForLayer(modeLayer, key)) {
			const hit = lastMatch(rs, subject);
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

	// Bash: match the full command against the bash ruleset. No path/external
	// logic since bash takes a free-form string.
	if (key === "bash") {
		const cmd = input.bashCommand ?? "";
		const v = evaluateOne(input, cmd, "bash");
		return {
			verdict: v,
			reason:
				v === "allow"
					? ""
					: `bash command ${v === "deny" ? "denied" : "needs approval"}: ${truncate(cmd, 120)}`,
		};
	}

	// Path-based tools: every path must pass. Strongest wins overall.
	if (input.paths.length === 0) return { verdict: "allow", reason: "" };

	let worst: Verdict = "allow";
	let worstSubject = "";
	for (const raw of input.paths) {
		const subject = normalize(raw, input.cwd);
		const pathVerdict = evaluateOne(input, subject, key);
		// External directory layer (independent of read/edit/write ruleset)
		let extVerdict: Verdict = "allow";
		if (isAbsolute(raw) && isExternal(raw, input.cwd)) {
			extVerdict = evaluateExternal(input, raw.replace(/\\/g, "/"));
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
