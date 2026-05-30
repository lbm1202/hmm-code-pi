import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveTools } from "../mode-tools.ts";

const ALL = ["read", "edit", "write", "bash", "grep", "find", "ls", "ask_user", "request_mode_switch", "finalize_plan", "todo_write"];

test("non-code modes strip edit/write (security invariant)", () => {
	for (const mode of ["plan", "debug", "ask"] as const) {
		const { tools, stripped } = resolveActiveTools(mode, ["read", "edit", "write", "bash"], ALL);
		assert.ok(!tools.includes("edit"), `${mode} must not have edit`);
		assert.ok(!tools.includes("write"), `${mode} must not have write`);
		assert.deepEqual(stripped.sort(), ["edit", "write"]);
	}
});

test("code mode keeps edit/write", () => {
	const { tools, stripped } = resolveActiveTools("code", ["read", "edit", "write"], ALL);
	assert.ok(tools.includes("edit") && tools.includes("write"));
	assert.deepEqual(stripped, []);
});

test("ask_user + request_mode_switch are always injected", () => {
	for (const mode of ["plan", "code", "debug", "ask"] as const) {
		const { tools } = resolveActiveTools(mode, [], ALL);
		assert.ok(tools.includes("ask_user"), mode);
		assert.ok(tools.includes("request_mode_switch"), mode);
	}
});

test("plan gets finalize_plan; code/debug get todo_write; ask/plan don't", () => {
	assert.ok(resolveActiveTools("plan", [], ALL).tools.includes("finalize_plan"));
	assert.ok(!resolveActiveTools("code", [], ALL).tools.includes("finalize_plan"));
	assert.ok(resolveActiveTools("code", [], ALL).tools.includes("todo_write"));
	assert.ok(resolveActiveTools("debug", [], ALL).tools.includes("todo_write"));
	assert.ok(!resolveActiveTools("ask", [], ALL).tools.includes("todo_write"));
	assert.ok(!resolveActiveTools("plan", [], ALL).tools.includes("todo_write"));
});

test("result is filtered to tools Pi actually knows about", () => {
	// allToolNames lacks finalize_plan → it's dropped even for plan.
	const { tools } = resolveActiveTools("plan", ["read"], ["read", "ask_user", "request_mode_switch"]);
	assert.ok(!tools.includes("finalize_plan"));
	assert.deepEqual(tools.sort(), ["ask_user", "read", "request_mode_switch"]);
});
