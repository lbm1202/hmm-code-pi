import { test } from "node:test";
import assert from "node:assert/strict";
import { lastMatchShell } from "../permissions/glob.ts";
import { BASH_DEFAULT, BASH_READ_ONLY } from "../permissions/bash-rules.ts";

const verdict = (rules: Record<string, string>, cmd: string) =>
	lastMatchShell(rules, cmd)?.value;

test("BASH_DEFAULT: ask baseline, safe reads allowed", () => {
	assert.equal(BASH_DEFAULT["*"], "ask");
	assert.equal(verdict(BASH_DEFAULT, "cat foo.txt"), "allow");
	assert.equal(verdict(BASH_DEFAULT, "some-unknown-cmd --flag"), "ask");
});

test("BASH_DEFAULT: shell metachars downgrade an otherwise-allowed command", () => {
	// `cat *` allows, but a pipe must re-gate to ask so `cat x | rm y` can't slip through.
	assert.equal(verdict(BASH_DEFAULT, "cat x | rm y"), "ask");
	assert.equal(verdict(BASH_DEFAULT, "cat x; rm y"), "ask");
	assert.equal(verdict(BASH_DEFAULT, "cat x && rm y"), "ask");
	assert.equal(verdict(BASH_DEFAULT, "cat $(rm y)"), "ask");
});

test("BASH_READ_ONLY: deny baseline, read-only allows, no mutators", () => {
	assert.equal(BASH_READ_ONLY["*"], "deny");
	assert.equal(verdict(BASH_READ_ONLY, "cat foo"), "allow");
	assert.equal(verdict(BASH_READ_ONLY, "ls"), "allow");
	assert.equal(verdict(BASH_READ_ONLY, "rm -rf /"), "deny");
	assert.equal(verdict(BASH_READ_ONLY, "echo hi | tee out"), "deny");
});

test("bare and with-args forms both present for no-arg commands", () => {
	for (const cmd of ["ls", "pwd", "echo", "tree"]) {
		assert.equal(BASH_READ_ONLY[cmd], "allow", `bare "${cmd}"`);
		assert.equal(BASH_READ_ONLY[cmd + " *"], "allow", `"${cmd} *"`);
	}
});
