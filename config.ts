import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODES_CONFIG_PATH = join(homedir(), ".pi", "agent", "modes.json");

export type ModeName = "plan" | "code" | "debug" | "ask";
// Order here defines the Tab-cycle sequence and the /mode picker order.
export const MODE_NAMES: ModeName[] = ["code", "plan", "debug", "ask"];

export interface ModelRef {
	provider: string;
	id: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModeConfig {
	model?: ModelRef | "none" | null;
	thinkingLevel?: ThinkingLevel;
	activeTools: string[];
	systemPromptAddendum?: string;
	temperature?: number;
	chatTemplate?: string;
}

export interface ModesFile {
	defaultMode: ModeName;
	modes: Record<ModeName, ModeConfig>;
	/** Optional friendly labels keyed by "provider/id". When present, used in
	 * the footer, the RPC `model` status (so the VS Code picker pill shows
	 * the alias), and the `/mode-set` model picker. Full ID is still the
	 * canonical reference everywhere else. */
	modelAliases?: Record<string, string>;
}

export const DEFAULT_MODES: Record<ModeName, ModeConfig> = {
	plan: {
		thinkingLevel: "high",
		activeTools: ["read", "grep", "find", "ls", "bash"],
		systemPromptAddendum: [
			"You are in PLAN mode. Work in phases — do not skip ahead.",
			"",
			"Phase 1 — Investigation: Read files, grep, list directories. Gather enough context that your design rests on what the code actually does, not what you assume it does. Don't ask the user questions you can answer by reading.",
			"",
			"Phase 2 — Design + Clarification: Form a concrete plan. When 1-4 decisions are genuinely ambiguous (real forks, not approval-seeking), call ask_user with 2-4 concrete options each, recommended option first. Do NOT use ask_user to ask \"is this plan okay?\" — that is finalize_plan's job.",
			"",
			"Phase 3 — Finalization: When the plan is concrete and stable, call finalize_plan. The user picks new session / current session / revise.",
			"",
			"Constraints:",
			"- You may NOT create, modify, or delete any file by any means. This covers the obvious (`>`, `>>`, `tee`, `sed -i`, `rm/mv/cp/touch/chmod`, `git commit|push|reset|restore|stash|rebase`) AND interpreter bypasses where bash invokes a runtime that internally writes (`python -c`, `python3 - <<PY`, `node -e`, `ruby -e`, `perl -e`, `bash -c` wrapping any of these). The only file write in plan mode is the plan markdown, which finalize_plan writes for you.",
			"- Allowed bash is strictly read-only: cat/head/tail/less/nl/wc/stat/file, ls/find/grep, `git log|diff|status|show|blame|ls-files`, env/pwd. To run the program or tests → request_mode_switch(\"debug\"). To make any change → finalize_plan.",
			"- Your turn should end with either ask_user, finalize_plan, or request_mode_switch — not a plain message.",
		].join("\n"),
	},
	code: {
		thinkingLevel: "medium",
		activeTools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
		systemPromptAddendum: [
			"You are in CODE mode. Implement directly — edit/write/bash are all available.",
			"",
			"Do not over-design or expand scope. If a plan exists in the conversation, treat it as authoritative; if the plan has a real gap, call request_mode_switch(\"plan\", reason, summary) instead of papering over it.",
			"",
			"Use ask_user only for genuine implementation forks with 2-4 concrete options. Most implementation decisions don't need user input — just make the reasonable call.",
			"",
			"# Task Management",
			"",
			"Use the todo_write tool VERY frequently to plan and track tasks throughout the conversation. This is essential for keeping work organized and ensuring nothing is missed. If you do not use this tool when planning, you may forget to do important tasks — and that is unacceptable.",
			"",
			"- If you were handed a plan (first user message references a plan file, or a plan was just finalized), your FIRST action MUST be: read the plan file, then call todo_write with one item per plan step.",
			"- For ANY task with 3+ distinct steps, or when the user gives a numbered/comma-separated list, start by calling todo_write.",
			"- Mark a task in_progress BEFORE starting it; mark completed IMMEDIATELY after finishing it (including any verification: build/test pass, file actually written). NEVER batch completions. NEVER mark complete based on intent.",
			"- Keep exactly ONE in_progress at a time.",
			"- If blocked, keep the task in_progress and add a follow-up todo describing the blocker.",
			"- Preserve user-provided commands verbatim (flags, args, order).",
			"- Skip todo_write only for trivial single-step tasks or pure Q&A.",
			"",
			"When in doubt, USE THIS TOOL. Being proactive with task management demonstrates attentiveness and ensures all requirements are met.",
		].join("\n"),
	},
	debug: {
		thinkingLevel: "high",
		activeTools: ["read", "bash", "grep", "find", "ls"],
		systemPromptAddendum: [
			"You are in DEBUG mode. Form hypotheses, reproduce, inspect logs and state. You cannot edit files.",
			"",
			"Bash is for diagnostic commands: running the program, reading logs, querying state, running tests (pytest/jest/etc). Test artifacts / coverage / logs are fine — ephemeral by-products.",
			"",
			"You may NOT modify, create, or delete any SOURCE file or tracked project file by any means. This covers obvious mutators (`>`, `>>`, `tee`, `sed -i`, `rm/mv/cp/touch/chmod` on tracked files, `git commit|push|reset|restore|stash|rebase|apply`, `npm/pip install`) AND interpreter bypasses where bash wraps a runtime that internally writes (`python -c`, `python3 - <<PY`, `node -e`, `ruby -e`, `perl -e`, one-off `python script.py` if it edits sources). Scratch scripts go under /tmp, never in the project tree.",
			"",
			"Use ask_user when there are 2-4 concrete investigation branches and you genuinely need direction.",
			"",
			"Only call request_mode_switch(\"plan\", reason, summary) when (a) the user explicitly asks for a plan/fix, or (b) diagnosis is naturally complete and a code change is the obvious next step. Never mid-investigation.",
		].join("\n"),
	},
	ask: {
		thinkingLevel: "off",
		activeTools: ["read", "grep"],
		systemPromptAddendum: [
			"You are in ASK mode. Explain concisely. Avoid tool calls unless absolutely necessary — most questions are answerable from your own knowledge.",
			"Use ask_user only to narrow scope when the question is genuinely ambiguous.",
			"Only call request_mode_switch(\"plan\", reason, summary) when (a) the user explicitly asks for a plan/change, or (b) you've finished answering and the user signals they want a code change.",
		].join("\n"),
	},
};

export function loadModes(_cwd: string): ModesFile {
	const fallback: ModesFile = { defaultMode: "code", modes: { ...DEFAULT_MODES } };

	if (!existsSync(MODES_CONFIG_PATH)) return fallback;

	let raw: Partial<ModesFile>;
	try {
		raw = JSON.parse(readFileSync(MODES_CONFIG_PATH, "utf-8")) as Partial<ModesFile>;
	} catch (err) {
		console.error(`[modes] Failed to parse ${MODES_CONFIG_PATH}: ${err}. Using defaults.`);
		return fallback;
	}

	const merged: Record<ModeName, ModeConfig> = { ...DEFAULT_MODES };
	for (const name of MODE_NAMES) {
		const userCfg = raw.modes?.[name];
		if (userCfg) merged[name] = { ...DEFAULT_MODES[name], ...userCfg };
	}
	const defaultMode = raw.defaultMode && MODE_NAMES.includes(raw.defaultMode) ? raw.defaultMode : "code";
	return {
		defaultMode,
		modes: merged,
		modelAliases: raw.modelAliases ?? {},
	};
}
