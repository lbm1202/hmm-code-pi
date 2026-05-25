// todo_write — task-list tool. Spec aligned with OpenCode/Kilo Code's
// `todowrite` (single write-only tool, full replacement per call, content +
// status + priority). Statuses align with OpenCode: pending / in_progress /
// completed / cancelled. Server-side: persist per-session + soft warn on
// multiple in_progress + push current list as a setStatus hint for clients.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STATUS_KEYS } from "./constants";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
type TodoPriority = "high" | "medium" | "low";
interface Todo {
	content: string;
	status: TodoStatus;
	priority: TodoPriority;
}

const STATUS_ICON: Record<TodoStatus, string> = {
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
	cancelled: "✕",
};

const TODO_DESCRIPTION = [
	"Create and maintain a structured task list for the current coding session. Use proactively for any non-trivial work.",
	"",
	"WHEN TO USE",
	"- The task requires 3+ distinct steps.",
	"- The user provides a numbered or comma-separated list of asks.",
	"- A plan was just finalized — convert each plan step into a todo.",
	"- New instructions arrive mid-work: append them as new todos.",
	"- After finishing a task, mark it completed and surface the next one as in_progress.",
	"",
	"WHEN NOT TO USE",
	"- Trivial single-step tasks (one edit, one shell command).",
	"- Pure Q&A / conversation with no action.",
	"",
	"STATES",
	"- pending: not yet started.",
	"- in_progress: currently being worked on. Exactly ONE at a time.",
	"- completed: actually finished, including verification (build/test pass, file written, etc.).",
	"- cancelled: no longer applicable; explain in a follow-up message.",
	"",
	"RULES",
	"- Update status in real time as you work. NEVER batch completions.",
	"- Mark a task in_progress BEFORE starting it.",
	"- Mark a task completed ONLY after the required work is actually done. NEVER based on intent.",
	"- If blocked or partial, keep it in_progress and add a follow-up todo describing the blocker.",
	"- Preserve user-provided commands verbatim (flags, args, order).",
	"- Send the FULL replacement list every call.",
].join("\n");

const TodoSchema = Type.Object({
	content: Type.String({ description: "Brief imperative description of the task." }),
	status: Type.String({
		description: "One of: pending, in_progress, completed, cancelled.",
	}),
	priority: Type.String({
		description: "One of: high, medium, low.",
	}),
});

const TodoParams = Type.Object({
	todos: Type.Array(TodoSchema, {
		minItems: 1,
		description: "Full replacement list. Send all todos every call.",
	}),
});

export function registerTodo(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Update task list",
		description: TODO_DESCRIPTION,
		parameters: TodoParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const todos = (params.todos ?? []) as Todo[];

			// Soft validation: status + priority enum.
			const VALID_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
			const VALID_PRIORITY = new Set(["high", "medium", "low"]);
			const issues: string[] = [];
			for (const [i, t] of todos.entries()) {
				if (!VALID_STATUS.has(t.status)) {
					issues.push(`todo[${i}] invalid status: ${t.status}`);
				}
				if (!VALID_PRIORITY.has(t.priority)) {
					issues.push(`todo[${i}] invalid priority: ${t.priority}`);
				}
			}
			const inProg = todos.filter((t) => t.status === "in_progress").length;
			if (inProg > 1) {
				issues.push(`${inProg} items are in_progress — only one allowed at a time.`);
			}
			if (issues.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `todo_write rejected:\n- ${issues.join("\n- ")}`,
						},
					],
					isError: true,
				};
			}

			// Persist per-session.
			try {
				(ctx.sessionManager as any).appendCustomEntry?.("modes-todos", { todos });
			} catch (err) {
				console.error("[modes:todo] appendCustomEntry failed:", err);
			}

			// Push to clients (VS Code webview etc).
			try {
				ctx.ui.setStatus(STATUS_KEYS.TODOS, JSON.stringify({ todos }));
			} catch (err) {
				console.error("[modes:todo] setStatus failed:", err);
			}

			return {
				content: [{ type: "text", text: formatTodoText(todos) }],
				details: { todos },
			};
		},
	});
}

function formatTodoText(todos: Todo[]): string {
	const lines = todos.map((t) => `${STATUS_ICON[t.status] ?? "•"} ${t.content}`);
	const done = todos.filter((t) => t.status === "completed").length;
	return `Task list (${done}/${todos.length} done):\n${lines.join("\n")}`;
}
