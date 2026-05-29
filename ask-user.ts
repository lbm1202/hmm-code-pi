import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface AskAnswer {
	topic: string;
	question: string;
	/** One label (single-select) or multiple labels joined by ", " (multi-select). */
	selected: string;
	/** Array form — populated for both single (length 1) and multi-select (any). */
	selectedAll: string[];
	wasOther: boolean;
	multiSelect: boolean;
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
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"Set true when the user should pick multiple (non-exclusive) options. Default false (single-select).",
		}),
	),
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
				const multi = q.multiSelect === true;
				const labels = q.options.map((o, i) =>
					o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`,
				);
				// Append an "Other (type your own)" option for TUI clients (where
				// ctx.ui.select only renders predefined options — no inline free-text
				// channel). RPC clients (VS Code webview) are expected to detect this
				// label and hide it, since they expose an inline textarea instead.
				const otherLabel = `${q.options.length + 1}. Other (type your own)`;
				labels.push(otherLabel);

				const titlePrefix = multi ? `[${q.topic}] (multi-select) ` : `[${q.topic}] `;

				if (multi) {
					// TUI multi-select: Pi doesn't have a native multi-pick UI, so we
					// loop ui.select with a "Done" sentinel — user picks one option
					// per round, picking "Done" finishes (or "Other" pops a single
					// free-text). RPC clients (VS Code webview) instead receive the
					// labels joined by "\n" and return a comma-separated string of
					// chosen labels in one shot — we detect both paths below.
					const DONE = `${q.options.length + 2}. ✓ Done`;
					const labelsForMulti = [...labels, DONE];
					const picked = new Set<string>();
					let otherText: string | undefined;
					while (true) {
						const title = `${titlePrefix}${q.question}${picked.size > 0 ? `\n\nSelected: ${[...picked].join(", ")}` : ""}`;
						const choice = await ctx.ui.select(title, labelsForMulti);
						if (choice == null) {
							return {
								content: [
									{
										type: "text",
										text: `User cancelled at "${q.topic}". Continue without these answers.`,
									},
								],
								details: { cancelled: true, answers },
							};
						}
						// RPC clients may return comma-separated label list as a one-shot.
						if (
							!labelsForMulti.includes(choice) &&
							choice !== otherLabel &&
							choice !== DONE
						) {
							// Parse "label1, label2" or single free text
							const parts = choice
								.split(",")
								.map((p) => p.trim())
								.filter(Boolean);
							for (const p of parts) {
								const matched = labels.find(
									(l) => l.replace(/^\d+\.\s+/, "").split(" — ")[0] === p,
								);
								if (matched) {
									picked.add(matched.replace(/^\d+\.\s+/, "").split(" — ")[0]);
								} else {
									// Treat as free-text other
									otherText = otherText ? `${otherText}, ${p}` : p;
								}
							}
							break;
						}
						if (choice === DONE) {
							if (picked.size === 0 && !otherText) {
								// Nothing picked — let them keep going or cancel
								continue;
							}
							break;
						}
						if (choice === otherLabel) {
							const written = await ctx.ui.input(`[${q.topic}] Type your answer`, "");
							if (written && written.trim()) {
								otherText = written.trim();
							}
							continue;
						}
						// Numbered option — toggle in/out
						const stripped = choice.replace(/^\d+\.\s+/, "").split(" — ")[0];
						if (picked.has(stripped)) picked.delete(stripped);
						else picked.add(stripped);
					}
					const selectedAll = [...picked];
					if (otherText) selectedAll.push(otherText);
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: selectedAll.join(", "),
						selectedAll,
						wasOther: !!otherText,
						multiSelect: true,
					});
					continue;
				}

				// Single-select path
				const choice = await ctx.ui.select(`${titlePrefix}${q.question}`, labels);
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
					const written = await ctx.ui.input(`[${q.topic}] Type your answer`, "");
					if (!written || !written.trim()) {
						return {
							content: [
								{ type: "text", text: `User cancelled the free-text answer for "${q.topic}".` },
							],
							details: { cancelled: true, answers },
						};
					}
					const text = written.trim();
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: text,
						selectedAll: [text],
						wasOther: true,
						multiSelect: false,
					});
				} else if (labels.includes(choice)) {
					const stripped = choice.replace(/^\d+\.\s+/, "").split(" — ")[0];
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: stripped,
						selectedAll: [stripped],
						wasOther: false,
						multiSelect: false,
					});
				} else {
					answers.push({
						topic: q.topic,
						question: q.question,
						selected: choice.trim(),
						selectedAll: [choice.trim()],
						wasOther: true,
						multiSelect: false,
					});
				}
			}

			const summary = answers
				.map((a) => {
					const txt = a.multiSelect ? `[${a.selectedAll.join(" + ")}]` : a.selected;
					return `- [${a.topic}] ${txt}${a.wasOther ? " (incl. free-text)" : ""}`;
				})
				.join("\n");
			return {
				content: [{ type: "text", text: `User responses:\n${summary}` }],
				details: { cancelled: false, answers },
			};
		},
	});
}
