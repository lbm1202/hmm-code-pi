import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { matches, lastMatch, lastMatchShell } from "../permissions/glob.ts";

test("path-mode * does not cross /", () => {
	assert.equal(matches("src/*.ts", "src/a.ts"), true);
	assert.equal(matches("src/*.ts", "src/sub/a.ts"), false);
});

test("path-mode ** crosses /", () => {
	assert.equal(matches("src/**", "src/sub/deep/a.ts"), true);
	assert.equal(matches("**/*.ts", "a/b/c.ts"), true);
});

test("~/ expands to home", () => {
	const home = homedir().replace(/\\/g, "/");
	assert.equal(matches("~/.ssh/**", home + "/.ssh/id_rsa"), true);
	assert.equal(matches("~/.ssh/*", home + "/.ssh/id_rsa"), true);
	assert.equal(matches("~/.ssh/*", home + "/.ssh/sub/k"), false);
});

test("lastMatch is last-match-wins", () => {
	const rules = { "**": "ask", "src/**": "allow" } as const;
	assert.equal(lastMatch(rules, "src/x.ts")?.value, "allow");
	assert.equal(lastMatch(rules, "other/x.ts")?.value, "ask");
	assert.equal(lastMatch(undefined, "x"), undefined);
});

test("shell-mode * crosses / (unlike path mode)", () => {
	// Path mode: "*" would not match "a/b"; shell mode treats it as .*
	assert.equal(matches("cat *", "cat a/b/c"), false); // path semantics
	assert.equal(lastMatchShell({ "cat *": "allow" }, "cat a/b/c")?.value, "allow");
	// Metachar gate beats an earlier allow under last-match-wins.
	assert.equal(lastMatchShell({ "cat *": "allow", "*|*": "ask" }, "cat x | rm y")?.value, "ask");
});
