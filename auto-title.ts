// Auto-generate a short session title from the first user message + first
// assistant response. Prefers a small/fast GPT model (cheap dedicated naming);
// falls back to code-mode's configured model, then to the current ctx model.
// Runs once per session.

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModeState } from "./state";

const titledSessions = new Set<string>();

const TITLE_SYSTEM_PROMPT =
	"You generate a very short (3–7 words) descriptive title summarizing what the user is trying to do. " +
	"Use the user's language. Respond with ONLY the title — no quotes, no markdown, no preamble, no trailing punctuation.";

// Candidate GPT model IDs to try, in order. First one found in the registry
// wins. User can also override via modes.json:
//   "autoTitle": { "provider": "openai", "id": "gpt-4o-mini" }
const GPT_CANDIDATES: { provider: string; id: string }[] = [
	{ provider: "openai", id: "gpt-4.1-nano" },
	{ provider: "openai", id: "gpt-4o-mini" },
	{ provider: "openai", id: "gpt-4.1-mini" },
	{ provider: "openai", id: "gpt-4o" },
	{ provider: "openai", id: "gpt-3.5-turbo" },
];

function resolveTitleModel(ctx: any, state: ModeState): { model: any; via: string } | null {
	// Skip models that have no API key configured — they'd just error out and
	// trigger our user-message fallback anyway.
	const authed = (m: any) => {
		if (!m) return false;
		try {
			return ctx.modelRegistry?.hasConfiguredAuth?.(m) !== false;
		} catch {
			return false;
		}
	};
	const override = state.autoTitleOverride;
	if (override && override.provider && override.id) {
		const m = ctx.modelRegistry?.find?.(override.provider, override.id);
		if (m && authed(m)) return { model: m, via: `override:${override.provider}/${override.id}` };
	}
	for (const c of GPT_CANDIDATES) {
		const m = ctx.modelRegistry?.find?.(c.provider, c.id);
		if (m && authed(m)) return { model: m, via: `gpt:${c.provider}/${c.id}` };
	}
	const codeRef = state.configFor("code")?.model;
	if (codeRef && codeRef !== "none" && typeof codeRef === "object") {
		const m = ctx.modelRegistry?.find?.(codeRef.provider, codeRef.id);
		if (m && authed(m)) return { model: m, via: `code-mode:${codeRef.provider}/${codeRef.id}` };
	}
	if (ctx.model && authed(ctx.model)) {
		return { model: ctx.model, via: `ctx.model:${ctx.model.provider}/${ctx.model.id}` };
	}
	return null;
}

export function registerAutoTitle(pi: ExtensionAPI, state: ModeState): void {
	pi.on("message_end", async (event: any, ctx: any) => {
		if (event?.message?.role !== "assistant") return;

		const sessionId: string | undefined = ctx.sessionManager?.getSessionId?.();
		if (!sessionId || titledSessions.has(sessionId)) return;

		const existing = (pi as any).getSessionName?.() ?? ctx.sessionManager?.getSessionName?.();
		if (existing) {
			titledSessions.add(sessionId);
			return;
		}

		const branch: any[] = ctx.sessionManager?.getBranch?.() ?? [];
		const firstUserEntry = branch.find((e) => e?.type === "message" && e.message?.role === "user");
		if (!firstUserEntry) return;

		const picked = resolveTitleModel(ctx, state);
		if (!picked) {
			console.error("[auto-title] no model available");
			return;
		}
		const model = picked.model;
		console.error("[auto-title] using", picked.via);

		// Mark BEFORE async to prevent re-entry on subsequent message_end events.
		titledSessions.add(sessionId);

		const userText = extractText(firstUserEntry.message?.content);
		const assistantText = extractText(event.message?.content);

		// Resolve apiKey/headers — ctx.modelRegistry.find() returns the Model
		// WITHOUT credentials (those live in AuthStorage). Pass via options.
		let resolvedApiKey: string | undefined;
		let resolvedHeaders: Record<string, string> | undefined;
		try {
			const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
			if (auth?.ok) {
				resolvedApiKey = auth.apiKey;
				resolvedHeaders = auth.headers;
			} else if (auth && !auth.ok) {
				console.error("[auto-title] auth resolve failed:", auth.error);
			}
		} catch (err) {
			console.error("[auto-title] auth lookup threw:", err);
		}

		let title = "";
		try {
			const context = {
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Conversation so far:\n\nUser: ${userText.slice(0, 600)}\n\nAssistant: ${assistantText.slice(0, 600)}\n\nNow write ONLY the title.`,
							},
						],
						timestamp: Date.now(),
					},
				],
				tools: [],
			};
			const result = await completeSimple(model as any, context, {
				apiKey: resolvedApiKey,
				headers: resolvedHeaders,
				reasoning: "off",
				metadata: {
					chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
				},
			} as any);
			const stopReason = (result as any)?.stopReason;
			const errorMessage = (result as any)?.errorMessage;
			if (stopReason === "error" || errorMessage) {
				console.error("[auto-title] LLM error:", errorMessage, "stopReason:", stopReason);
			}
			title = pickTitle(extractText((result as any)?.content));
			if (!title) {
				const thinking = extractThinking((result as any)?.content);
				if (thinking) {
					const lastLine = thinking.split("\n").filter((l) => l.trim()).pop() ?? "";
					title = pickTitle(lastLine);
				}
			}
		} catch (err) {
			console.error("[auto-title] completeSimple threw:", err);
		}

		if (!title) title = pickTitle(userText);
		if (!title) return;

		const setFn = (pi as any).setSessionName ?? ctx.setSessionName;
		if (typeof setFn === "function") setFn(title);
	});
}

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: any) => p && p.type === "text" && typeof p.text === "string")
		.map((p: any) => p.text)
		.join("");
}

function extractThinking(content: any): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: any) => p && p.type === "thinking" && typeof p.thinking === "string")
		.map((p: any) => p.thinking)
		.join("\n");
}

/** Squash whitespace, strip quotes/markdown, prefer first sentence, cap 30. */
function pickTitle(raw: string): string {
	if (!raw) return "";
	let s = raw
		.replace(/\r/g, "")
		.replace(/^\s*[-*]\s+/gm, "")
		.replace(/^#+\s*/gm, "")
		.replace(/^\s*["'`「『]+|["'`」』]+\s*$/g, "")
		.trim();
	s = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	const sentenceEnd = s.search(/[.?!。！？]/);
	if (sentenceEnd >= 0 && sentenceEnd < 80) {
		s = s.slice(0, sentenceEnd);
	}
	s = s.replace(/\s+/g, " ").trim();
	if (s.length <= 30) return s;
	return s.slice(0, 28).trim() + "…";
}
