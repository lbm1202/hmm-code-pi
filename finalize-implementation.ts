// finalize_implementation — the code-mode mirror of finalize_plan. The
// implementing session calls it once the plan's steps are done and validated;
// the user then picks what happens next (mirroring finalize_plan's dialog):
//   1. Hand off to review — writes the implementation report under
//      ~/.pi/agent/reports/ and starts the review. RPC clients (VS Code) get a
//      REVIEW_HANDOFF status ("<reportPath>|<parentSessionPath or empty>") and
//      orchestrate the switch back to the parent plan session (or review in
//      place when there is no parent — current-session plan executions);
//      TUI reviews in the current session via the agent_end fresh-loop dispatch.
//   2. Continue implementing — free-form feedback is fed back to the model;
//      no report is written.
//   3. Not now — defer; no report is written; call again when the user asks.
// Headless runs skip the dialog and auto-start a same-session review.
//
// The tool is only injected into code mode when the session has a review
// target (parent plan session, or finalize_plan ran in this session) — see
// mode-tools.ts / state.hasReviewTarget. The guard below is defense in depth.

import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STATUS_KEYS } from "./constants";
import { L } from "./l10n";
import { REPORTS_DIR, uniqueReportPath } from "./plans";
import type { ModeState } from "./state";

const CHOICE_REVIEW = L("1. Hand off to review");
const CHOICE_CONTINUE = L("2. Continue implementing");
const CHOICE_LATER = L("3. Not now");

export function registerFinalizeImplementation(pi: ExtensionAPI, state: ModeState) {
	pi.registerTool({
		name: "finalize_implementation",
		label: "Finalize implementation",
		description:
			"Signal that a plan implementation is COMPLETE and offer the user the review handoff. Call ONLY after the final acceptance pass — every plan step done, the plan's validation entries actually run — in a session implementing a finalized plan. The user picks: hand off to review, continue implementing, or defer.",
		parameters: Type.Object({
			summary: Type.String({
				description:
					"One or two sentences stating WHAT was implemented — declarative outcome (\"Added X; refactored Y\"), not a narration of the work.",
			}),
			changes: Type.Array(Type.String(), {
				description:
					"File-by-file record: `<path>: <what changed>` for every file created, modified, or deleted. The reviewer reads these files — a missing entry hides that change from review.",
			}),
			validation_results: Type.Array(Type.String(), {
				description:
					"Outcome of each validation entry from the plan (plus any extra checks you ran): `<command or check> — PASS` or `— FAIL: <detail>`. Include entries you could NOT run with the reason, and list `(human)` entries as `SKIPPED (human)`. Never silently drop one.",
			}),
			deviations: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Where the implementation intentionally differs from the plan (different approach, renamed file, skipped step) — each with a one-line why. Omit when none.",
				}),
			),
			plan_path: Type.Optional(
				Type.String({
					description:
						"Absolute path of the plan file this session implemented (from the handoff message). Fallback for the reviewer if the plan is no longer in their context.",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.current !== "code") {
				return {
					content: [
						{
							type: "text",
							text: `finalize_implementation is code-mode only (current: ${state.current}).`,
						},
					],
					isError: true,
				};
			}

			// Defense in depth — the tool isn't injected without a review target,
			// but a stale tool list or manual activeTools edit could still get here.
			const parentSession = state.parentSessionPath(ctx) ?? "";
			if (!parentSession && !state.planFinalizedInSession) {
				return {
					content: [
						{
							type: "text",
							text: "No review target: this session has neither a parent plan session nor a plan finalized in it. finalize_implementation is not available here — just summarize the work for the user.",
						},
					],
					isError: true,
				};
			}

			const report = buildReportMarkdown(
				{
					summary: params.summary,
					changes: params.changes,
					validationResults: params.validation_results,
					deviations: params.deviations,
					planPath: params.plan_path,
				},
				ctx.model?.provider,
				ctx.model?.id,
			);

			// Headless: no dialog — auto-start a same-session review (mirrors
			// finalize_plan's headless auto-current branch).
			if (!ctx.hasUI) {
				const reportPath = writeReport(report);
				state.pendingReviewRevertMode = state.current; // auto-return after the review reply
				await state.apply("review", ctx);
				state.pendingModeSwitchMessage = reviewMessageBody(reportPath);
				ctx.ui.notify(`Implementation report → ${reportPath} (headless: auto review)`, "info");
				return {
					content: [
						{
							type: "text",
							text: `Implementation report saved → ${reportPath}. Switched to review (headless); review dispatch deferred to next turn.`,
						},
					],
					details: { reportPath, branch: "review_current_session_headless" },
					terminate: true,
				};
			}

			// TUI gets the report inline in the prompt (no tool-call body renderer);
			// RPC clients already render it via the finalize_implementation preview.
			const isTui = !!process.stdout.isTTY;
			const prompt = isTui
				? [L("Implementation complete."), "", report.trim(), "", "───────────────────────────────", L("What next?")].join("\n")
				: L("Implementation complete. What next?");
			const choice = await ctx.ui.select(prompt, [CHOICE_REVIEW, CHOICE_CONTINUE, CHOICE_LATER]);

			if (choice == null || choice === CHOICE_LATER) {
				return {
					content: [
						{
							type: "text",
							text: "User deferred the review. Stay in code mode and wait for their next message; call finalize_implementation again when they ask for the review.",
						},
					],
					details: { branch: "deferred" },
				};
			}

			if (choice === CHOICE_CONTINUE) {
				const feedback = await ctx.ui.input(
					L("What should be continued or changed?"),
					L("Type what's missing…"),
				);
				if (!feedback || !feedback.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "User wants to continue implementing but gave no specifics. Ask what they'd like changed, or wait for their next message.",
							},
						],
						details: { branch: "continue", feedback: null },
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`User wants to continue implementing:\n---\n${feedback.trim()}\n---\n` +
								"Address this, re-run the relevant validation, then call finalize_implementation again.",
						},
					],
					details: { branch: "continue", feedback: feedback.trim() },
				};
			}

			// CHOICE_REVIEW — the report is only persisted once a review actually
			// launches (continue/defer leave no artifact behind).
			const reportPath = writeReport(report);

			// RPC client (VS Code webview): hasUI but no TUI editor. Signal the
			// handoff and let the client orchestrate (switch to the parent plan
			// session when one exists, else review in place).
			if (!state.hasEditor()) {
				try {
					ctx.ui.setStatus(STATUS_KEYS.REVIEW_HANDOFF, `${reportPath}|${parentSession}`);
				} catch (err) {
					console.error("[modes:finalize-implementation] review-handoff setStatus failed:", err);
				}
				ctx.ui.notify(`Implementation report → ${reportPath}. Handing off to review.`, "info");
				return {
					content: [
						{
							type: "text",
							text:
								`Implementation report saved → ${reportPath}. Signaled client to hand off to review` +
								(parentSession ? " in the plan session." : "."),
						},
					],
					details: { reportPath, parentSession: parentSession || undefined, branch: "review_via_client" },
					terminate: true,
				};
			}

			// TUI: review in THIS session. Defer the review prompt to agent_end
			// (fresh loop) so it runs with the post-apply review-mode model/tools/
			// prompt — same reason as finalize_plan's deferred dispatch.
			state.pendingReviewRevertMode = state.current; // auto-return after the review reply
			await state.apply("review", ctx);
			state.pendingModeSwitchMessage = reviewMessageBody(reportPath);
			ctx.ui.notify(`Implementation report → ${reportPath}. Switched to review.`, "info");
			return {
				content: [
					{
						type: "text",
						text: `Implementation report saved → ${reportPath}. Switched to review; review dispatch deferred to next turn.`,
					},
				],
				details: { reportPath, branch: "review_current_session" },
				terminate: true,
			};
		},
	});
}

function writeReport(report: string): string {
	mkdirSync(REPORTS_DIR, { recursive: true });
	const reportPath = uniqueReportPath();
	writeFileSync(reportPath, report, "utf-8");
	return reportPath;
}

interface ReportFields {
	summary: string;
	changes: string[];
	validationResults: string[];
	deviations?: string[];
	planPath?: string;
}

function buildReportMarkdown(r: ReportFields, provider?: string, modelId?: string): string {
	const lines: string[] = [
		"# Implementation Report",
		"",
		`- Created: ${new Date().toISOString()}`,
		`- Plan: ${r.planPath?.trim() || "(not provided)"}`,
		`- Source model: ${provider ?? "?"}/${modelId ?? "?"}`,
		"",
		"## Summary",
		"",
		r.summary.trim(),
		"",
		"## Changes",
		"",
	];
	for (const c of r.changes) lines.push(`- ${c}`);

	lines.push("", "## Validation results", "");
	for (const v of r.validationResults) lines.push(`- ${v}`);

	if (r.deviations && r.deviations.length > 0) {
		lines.push("", "## Deviations from plan", "");
		for (const d of r.deviations) lines.push(`- ${d}`);
	}

	return `${lines.join("\n")}\n`;
}

/** Same-session review prompt (TUI / headless / no-parent fallback). The VS
 *  Code webview builds its own parent-session variant in helpers.ts. */
function reviewMessageBody(reportPath: string): string {
	return [
		"You are now in REVIEW mode. Review the implementation this session just completed against its plan.",
		"",
		`Implementation report: ${reportPath} — read it first.`,
		"The plan is in this session's context; if compaction removed it, re-read the plan file referenced in the report header.",
		"",
		"Follow the review protocol from your mode instructions: verify the changed files against the plan's steps and pinned seam contracts, run every entry in the plan's Validation section, and check for scope creep. End with PASS or a numbered findings list (file:line evidence, severity: blocker / should-fix / nit), then stop — do not fix anything.",
		"",
		'If the user asks for the fixes, call finalize_plan with the fix-list as steps (target_mode "code") to launch the next implementation round.',
	].join("\n");
}
