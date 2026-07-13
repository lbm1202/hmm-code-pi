import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MODE_NAMES, type ModeName } from "./config";
import { L, Lf } from "./l10n";
import type { ModeState } from "./state";

export function registerRequestModeSwitch(pi: ExtensionAPI, state: ModeState) {
	pi.registerTool({
		name: "request_mode_switch",
		label: "Request mode switch",
		description:
			"Ask the user for permission to switch the active mode. Use ONLY at natural breakpoints: the user explicitly asks to plan, or the current-mode work is naturally complete. Do not call mid-investigation.",
		parameters: Type.Object({
			target_mode: StringEnum(MODE_NAMES),
			reason: Type.String({ description: "1-2 sentences shown to the user explaining the switch" }),
			context_summary: Type.Optional(
				Type.String({
					description:
						"Short summary of what was done in the current mode. Injected as the user's next message in the target mode.",
				}),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const target = params.target_mode as ModeName;

			if (target === state.current) {
				return {
					content: [{ type: "text", text: `Already in ${target} mode.` }],
					isError: true,
				};
			}

			// Code is normally entered only via finalize_plan (the plan→code
			// invariant). Exception: a localized, already-diagnosed fix may switch
			// debug→code directly — the diagnosis is its spec, so routing a one-line
			// fix through a full plan round is wasted ceremony.
			if (target === "code" && state.current !== "debug") {
				return {
					content: [
						{
							type: "text",
							text: "Cannot enter code mode from here. Code is reached via finalize_plan (from plan or review), or directly from debug for a localized, already-diagnosed fix. Call finalize_plan instead (switch to plan first if you are not in plan/review).",
						},
					],
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Cannot prompt for mode switch in headless mode." }],
					isError: true,
				};
			}

			// confirm(title, message) — title is the short header, message the body.
			const confirmed = await ctx.ui.confirm(
				L("Mode switch?"),
				`${params.reason}\n\n${Lf("Switch from {from} to {to}?", { from: state.current, to: target })}`,
			);

			if (!confirmed) {
				return {
					content: [
						{
							type: "text",
							text: `User declined the switch. Continue in ${state.current} mode.`,
						},
					],
					details: { accepted: false, from: state.current, requested: target },
				};
			}

			const origin = state.current;
			await state.apply(target, ctx);

			// Stash the carry-over message instead of dispatching now: Pi's agent
			// loop captures model/activeTools/systemPrompt in createLoopConfig
			// once per runPromptMessages, so a same-loop deliverAs:"followUp"
			// would still run with the PRE-switch config (old tools, old prompt).
			// hooks.ts agent_end dispatches this in a fresh loop that reads the
			// post-apply state. Without this fix, e.g. ask→debug switch leaves
			// the follow-up turn without `bash` and the LLM correctly reports
			// "no command tool" even though the user is now in debug mode.
			if (params.context_summary && params.context_summary.trim()) {
				state.pendingModeSwitchMessage =
					`Carry-over from ${origin} mode:\n${params.context_summary.trim()}\n\nPlease continue.`;
			}

			return {
				content: [{ type: "text", text: `Switched to ${target} mode.` }],
				details: { accepted: true, from: origin, to: target },
				terminate: true,
			};
		},
	});
}
