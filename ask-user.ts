import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface AskAnswer {
	topic: string;
	question: string;
	selected: string;
	wasOther: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Choice text shown to the user" }),
	description: Type.Optional(Type.String({ description: "Short trade-off note" })),
});

const QuestionSchema = Type.Object({
	topic: Type.String({ description: "Short chip label (~12 chars), e.g. 'Library', 'Scope'" }),
	question: Type.String({ description: "The full question" }),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 options. Put recommended first and append '(recommended)'.",
	}),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "1-4 questions grouped by topic.",
	}),
});

export function registerAskUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user 1-4 multiple-choice questions to resolve ambiguous decisions. Each question gets 2-4 concrete options plus an auto-added 'Other' for free-text. Use ONLY for option-based decisions; use plain assistant prose for open-ended questions.",
		parameters: AskUserParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "ask_user: UI not available (headless mode)." }],
					isError: true,
				};
			}

			const answers: AskAnswer[] = [];
			for (const q of params.questions) {
				const labels = q.options.map((o, i) =>
					o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`,
				);
				// Append an "Other (type your own)" option for TUI clients (where
				// ctx.ui.select only renders predefined options — no inline free-text
				// channel). RPC clients (VS Code webview) are expected to detect this
				// label and hide it, since they expose an inline textarea instead.
				const otherLabel = `${q.options.length + 1}. Other (type your own)`;
				labels.push(otherLabel);

				const choice = await ctx.ui.select(`[${q.topic}] ${q.question}`, labels);
				if (choice == null) {
					return {
						content: [
							{
								type: "text",
								text: `User cancelled at "${q.topic}". Continue without these answers; ask again or proceed with safe defaults.`,
							},
						],
						details: { cancelled: true, answers },
					};
				}

				if (choice === otherLabel) {
					// TUI flow: chained ui.input prompt for free-text.
					const written = await ctx.ui.input(`[${q.topic}] Type your answer`, "");
					if (!written || !written.trim()) {
						return {
							content: [
								{ type: "text", text: `User cancelled the free-text answer for "${q.topic}".` },
							],
							details: { cancelled: true, answers },
						};
					}
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: written.trim(),
						wasOther: true,
					});
				} else if (labels.includes(choice)) {
					const stripped = choice.replace(/^\d+\.\s+/, "").split(" — ")[0];
					answers.push({ topic: q.topic, question: q.question, selected: stripped, wasOther: false });
				} else {
					// RPC inline-textarea path: any free-text the client returned that
					// doesn't match a numbered option.
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: choice.trim(),
						wasOther: true,
					});
				}
			}

			const summary = answers
				.map((a) => `- [${a.topic}] ${a.selected}${a.wasOther ? " (free-text)" : ""}`)
				.join("\n");
			return {
				content: [{ type: "text", text: `User responses:\n${summary}` }],
				details: { cancelled: false, answers },
			};
		},
	});
}
