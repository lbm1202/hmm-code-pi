// Permission system entry point. Hooks tool_call to evaluate every LLM tool
// invocation against the layered ruleset (base → mode defaults → user global
// → user project). Behaviors:
//   - allow  → pass through
//   - ask    → ctx.ui.confirm; cancel = block, accept = pass
//   - deny   → block with reason
//   - matched in .piignore → block (regardless of rule layer)
//
// Headless sessions (no UI surface) treat "ask" as a hard block so background
// runs can't get stuck waiting for input that will never come.

import { isAbsolute, relative } from "node:path";
import type { Runtime } from "../runtime";
import { BASE_DEFAULTS, MODE_DEFAULTS } from "./defaults";
import { evaluate } from "./evaluator";
import { extractPaths } from "./extract-paths";
import {
	loadGlobalPermissions,
	loadProjectPermissions,
	writePermissionsExampleIfMissing,
} from "./loader";
import { loadIgnore } from "./piignore";
import type { Permissions } from "./types";

/** Match piignore.ts's expectation: workspace-relative path with forward
 *  slashes. .piignore patterns are cwd-relative; an absolute path like
 *  `/Users/x/work/secret.key` would never match `secret.key` (or `**​/secret.key`)
 *  without this normalization, leaving piignore silently bypassable. */
function toIgnoreSubject(p: string, cwd: string): string | undefined {
	const fwd = p.replace(/\\/g, "/");
	if (!isAbsolute(fwd)) return fwd;
	const rel = relative(cwd, fwd).replace(/\\/g, "/");
	// Outside cwd → piignore (which lives at cwd/.piignore) has no
	// applicable rule. Skip rather than fall through with the absolute path,
	// which would only match patterns like `/Users/**` that users almost
	// never write.
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel || ".";
}

export function registerPermissions(rt: Runtime): void {
	const { pi, state } = rt;
	writePermissionsExampleIfMissing();

	pi.on("tool_call" as any, async (event: any, ctx: any) => {
		const toolName = String(event?.toolName ?? "");
		if (!toolName) return;

		const cwd = String(ctx?.cwd ?? process.cwd());
		const mode = state.current;
		const input = event?.input ?? {};

		// 1. .piignore — hard block regardless of permission rules
		const ignore = loadIgnore(cwd);
		if (ignore.hasRules()) {
			const { paths } = extractPaths(toolName, input);
			for (const p of paths) {
				const subject = toIgnoreSubject(p, cwd);
				if (subject === undefined) continue;
				if (ignore.isBlocked(subject)) {
					return {
						block: true,
						reason: `Blocked by .piignore: ${p}`,
					};
				}
			}
		}

		// 2. Layered rule evaluation
		const layers: Permissions[] = [
			BASE_DEFAULTS,
			{ modes: MODE_DEFAULTS } as Permissions,
		];
		const globalLayer = loadGlobalPermissions();
		if (globalLayer) layers.push(globalLayer);
		const projectLayer = loadProjectPermissions(cwd);
		if (projectLayer) layers.push(projectLayer);

		const { paths } = extractPaths(toolName, input);
		const bashCommand =
			toolName === "bash" ? String((input as { command?: string })?.command ?? "") : undefined;

		const decision = evaluate({
			toolName,
			mode,
			cwd,
			paths,
			bashCommand,
			layers,
		});

		if (decision.verdict === "allow") return;

		if (decision.verdict === "deny") {
			return { block: true, reason: decision.reason };
		}

		// "ask" — auto-approve bypass first. Session-scoped — a new session
		// always re-requires confirmation.
		if (state.autoApprove) return;

		// Needs a UI to surface the confirm dialog
		if (!ctx?.hasUI) {
			return {
				block: true,
				reason:
					decision.reason +
					" (headless session — cannot prompt; configure permissions.json to allow)",
			};
		}

		try {
			const accepted = await ctx.ui.confirm(
				"Permission",
				`Mode "${mode}" → ${decision.reason}\n\nAllow this action?`,
			);
			if (!accepted) {
				return { block: true, reason: "User denied permission" };
			}
		} catch (err) {
			return {
				block: true,
				reason: `Permission prompt failed: ${err}`,
			};
		}
	});
}
