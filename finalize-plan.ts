import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { STATUS_KEYS } from "./constants";
import { PLANS_DIR, uniquePlanPath } from "./plans";
import type { ModeState } from "./state";

const TARGETS = ["code", "debug"] as const;

const CHOICE_NEW = "1. Execute in NEW session";
const CHOICE_CURRENT = "2. Execute in CURRENT session";
const CHOICE_REVISE = "3. Revise the plan";

export function registerFinalizePlan(pi: ExtensionAPI, state: ModeState) {
	pi.registerTool({
		name: "finalize_plan",
		label: "Finalize plan",
		description:
			"Commit the final plan. Saves a markdown copy under ~/.pi/agent/plans/ and asks the user to pick: new session, current session, or revise.",
		parameters: Type.Object({
			summary: Type.String({
				description:
					"One- or two-sentence summary of the plan — shown in the picker / dialog preview. Keep it short; depth goes in `body`.",
			}),
			body: Type.String({
				description:
					"Free-form markdown design notes. Use `###` or lower (NEVER `##`) — the template wraps this in a `## Design` section, so `##` would collide with Summary/Steps. Include whatever helps: current state, file structure, data models, strategy, trade-offs, risks. Trivial changes can be 1-3 lines; bigger work should be richer.",
			}),
			steps: Type.Array(Type.String(), {
				description: "Ordered concrete steps for the implementing agent to follow.",
			}),
			validation: Type.Array(Type.String(), {
				description:
					"How to verify the implementation. Each entry is one command (e.g. `pytest tests/test_api.py`) or one scenario (e.g. `Hit /health and confirm 200`). For truly trivial changes use a single explicit entry like `No verification needed — single-file deletion`.",
			}),
			docs: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Documentation to add or update. Each entry names the file + what to change (e.g. `README.md: add Setup section`, `CHANGELOG.md: v0.2 entry`). Omit if no docs work.",
				}),
			),
			target_mode: Type.Optional(StringEnum(TARGETS)),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (state.current !== "plan") {
				return {
					content: [
						{ type: "text", text: `finalize_plan is plan-mode only (current: ${state.current}).` },
					],
					isError: true,
				};
			}

			const targetMode = (params.target_mode ?? "code") as "code" | "debug";
			const planMarkdown = buildPlanMarkdown(
				{
					summary: params.summary,
					body: params.body,
					steps: params.steps,
					validation: params.validation,
					docs: params.docs,
				},
				targetMode,
				ctx.model?.provider,
				ctx.model?.id,
			);

			mkdirSync(PLANS_DIR, { recursive: true });
			const planPath = uniquePlanPath();
			writeFileSync(planPath, planMarkdown, "utf-8");

			if (!ctx.hasUI) {
				await state.apply(targetMode, ctx);
				pi.sendUserMessage(planMessageBody(planMarkdown), { deliverAs: "followUp" });
				ctx.ui.notify(`Plan saved → ${planPath} (headless: auto current-session)`, "info");
				return {
					content: [
						{
							type: "text",
							text: `Plan saved → ${planPath}. Switched to ${targetMode} (headless fallback).`,
						},
					],
					details: { planPath, targetMode, branch: "current_session_headless" },
					terminate: true,
				};
			}

			// Include the plan body in the select prompt so CLI users can
			// review the full plan (summary + design + steps + validation +
			// docs) before committing to new-session / current-session / revise.
			// The header lines + path stay at the top; everything below "—" is
			// the plan markdown. VS Code clients get a richer inline preview
			// via their tool-call renderer, so this matters mostly for the TUI.
			const prompt = [
				`Plan saved → ${planPath}`,
				"",
				planMarkdown.trim(),
				"",
				"───────────────────────────────",
				"What next?",
			].join("\n");
			const choice = await ctx.ui.select(prompt, [
				CHOICE_NEW,
				CHOICE_CURRENT,
				CHOICE_REVISE,
			]);

			if (choice == null) {
				return {
					content: [
						{
							type: "text",
							text: `Plan saved → ${planPath}. User deferred the choice. Stay in plan mode and wait for their next message.`,
						},
					],
					details: { planPath, branch: "deferred" },
				};
			}

			if (choice === CHOICE_NEW) {
				// ctx.newSession is only available in command handlers. We stash the plan
				// for /plan-execute to consume, then auto-trigger that command by calling
				// the editor's onSubmit callback — same code path as if the user typed
				// "/plan-execute" and hit Enter. Pi's prompt() detects the slash prefix and
				// routes to the extension command (which has command context with newSession).
				// pi.sendUserMessage("/plan-execute") doesn't work — agent-session.js:1017
				// passes expandPromptTemplates:false which skips the slash-command path.
				state.pendingPlanPath = planPath;
				state.pendingTargetMode = targetMode;

				const editor = state.editorInstance;
				const onSubmit = editor?.onSubmit as ((text: string) => void) | undefined;
				if (typeof onSubmit === "function") {
					// Defer to next tick so the tool can fully return (terminate:true) before
					// the new-session creation runs — avoids reentrant agent-loop issues.
					setTimeout(() => {
						try {
							onSubmit.call(editor, "/plan-execute");
						} catch (err) {
							console.error("[modes] auto-trigger /plan-execute failed:", err);
						}
					}, 50);
					ctx.ui.notify(`Plan saved → ${planPath}. Launching new ${targetMode} session…`, "info");
					return {
						content: [
							{
								type: "text",
								text: `Plan saved → ${planPath}. Auto-launching a new ${targetMode} session via /plan-execute.`,
							},
						],
						details: { planPath, targetMode, branch: "new_session_auto" },
						terminate: true,
					};
				}

				// Fallback: editor onSubmit unavailable (RPC mode / VS Code extension).
				// Signal the client via setStatus so it can orchestrate the handoff:
				//   1. send {type:"new_session"} command
				//   2. on session_start, send {type:"prompt", message: <plan body>}
				try {
					ctx.ui.setStatus(STATUS_KEYS.PLAN_HANDOFF, `${planPath}|${targetMode}`);
				} catch (err) {
					console.error("[modes:finalize-plan] plan-handoff setStatus failed:", err);
				}
				ctx.ui.notify(
					`Plan saved → ${planPath}. Handing off to client for new ${targetMode} session.`,
					"info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Plan saved → ${planPath}. Signaled client to start new ${targetMode} session.`,
						},
					],
					details: { planPath, targetMode, branch: "new_session_via_client" },
					terminate: true,
				};
			}

			if (choice === CHOICE_CURRENT) {
				await state.apply(targetMode, ctx);
				// Defer pi.sendUserMessage to after agent_end. Reason: Pi's agent loop
				// captures model in createLoopConfig once per runPromptMessages call.
				// If we queue via deliverAs:"followUp" here, the follow-up runs in the
				// SAME loop with the PRE-finalize_plan model. Stashing the body and
				// dispatching from on("agent_end") starts a fresh loop that reads the
				// post-apply (target-mode) model from agent.state.
				state.pendingCurrentSessionPlanBody = planMessageBody(planMarkdown);
				ctx.ui.notify(
					`Switched to ${targetMode}. Plan will run after this turn ends.`,
					"info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Plan saved → ${planPath}. Switched to ${targetMode}; plan dispatch deferred to next turn (fresh model).`,
						},
					],
					details: { planPath, targetMode, branch: "current_session_deferred" },
					terminate: true,
				};
			}

			// CHOICE_REVISE
			const feedback = await ctx.ui.input("How should the plan be revised?", "Type your changes…");
			if (!feedback || !feedback.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "User requested revision but provided no specifics. Re-examine and call finalize_plan again with adjustments.",
						},
					],
					details: { planPath, branch: "revise", feedback: null },
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`User requested plan revision:\n---\n${feedback.trim()}\n---\n` +
							"Incorporate this feedback and call finalize_plan again.",
					},
				],
				details: { planPath, branch: "revise", feedback: feedback.trim() },
			};
		},
	});
}

interface PlanFields {
	summary: string;
	body: string;
	steps: string[];
	validation: string[];
	docs?: string[];
}

function buildPlanMarkdown(
	plan: PlanFields,
	targetMode: string,
	provider?: string,
	modelId?: string,
): string {
	const lines: string[] = [
		"# Plan",
		"",
		`- Created: ${new Date().toISOString()}`,
		`- Target mode: ${targetMode}`,
		`- Source model: ${provider ?? "?"}/${modelId ?? "?"}`,
		"",
		"## Summary",
		"",
		plan.summary.trim(),
	];

	if (plan.body && plan.body.trim()) {
		lines.push("", "## Design", "", plan.body.trim());
	}

	lines.push("", "## Steps", "");
	for (let i = 0; i < plan.steps.length; i++) {
		lines.push(`${i + 1}. ${plan.steps[i]}`);
	}

	if (plan.validation && plan.validation.length > 0) {
		lines.push("", "## Validation", "");
		for (const v of plan.validation) lines.push(`- ${v}`);
	}

	if (plan.docs && plan.docs.length > 0) {
		lines.push("", "## Documentation", "");
		for (const d of plan.docs) lines.push(`- ${d}`);
	}

	return `${lines.join("\n")}\n`;
}

function planMessageBody(planMarkdown: string): string {
	return [
		"You are now in CODE mode (handoff from plan). You are no longer read-only — edit/write/bash are available.",
		"",
		"Treat the plan below as authoritative scope. Implement exactly what it specifies; do not re-plan, expand scope, refactor adjacent code, or add features the plan did not ask for.",
		"",
		"First action: call todo_write with one item per plan step, then work through them one-by-one, marking in_progress before starting each and completed immediately after finishing.",
		"",
		"If the plan has a real gap (missing step, contradicts the code, wrong path), call request_mode_switch(\"plan\", reason, summary) instead of improvising.",
		"",
		planMarkdown,
	].join("\n");
}
