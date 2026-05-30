import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPaths } from "../permissions/extract-paths.ts";

test("known file tools extract their path", () => {
	for (const tool of ["read", "ls", "find", "edit", "write"]) {
		assert.deepEqual(extractPaths(tool, { path: "src/a.ts" }).paths, ["src/a.ts"], tool);
	}
	assert.deepEqual(extractPaths("read", { file_path: "b.ts" }).paths, ["b.ts"]);
});

test("grep uses path or glob", () => {
	assert.deepEqual(extractPaths("grep", { path: "src" }).paths, ["src"]);
	assert.deepEqual(extractPaths("grep", { glob: "*.ts" }).paths, ["*.ts"]);
});

test("multi_edit collects every per-edit path (deduped)", () => {
	const r = extractPaths("multi_edit", { edits: [{ path: "a" }, { file_path: "b" }, { path: "a" }] });
	assert.deepEqual(r.paths.sort(), ["a", "b"]);
});

test("file:// prefix is stripped", () => {
	assert.deepEqual(extractPaths("read", { path: "file:///etc/hosts" }).paths, ["/etc/hosts"]);
});

// The security fix: a renamed/unknown file-touching tool must still surface its
// path so the external_directory gate runs (empty paths => evaluator allows).
test("fail-closed: unknown tool with a path arg still extracts it", () => {
	assert.deepEqual(extractPaths("edit_file", { path: "~/.ssh/id_rsa" }).paths, ["~/.ssh/id_rsa"]);
	assert.deepEqual(extractPaths("whatever", { file_path: "/etc/passwd" }).paths, ["/etc/passwd"]);
	assert.deepEqual(
		extractPaths("batch_writer", { edits: [{ path: "/a" }, { file_path: "/b" }] }).paths.sort(),
		["/a", "/b"],
	);
});

test("genuinely path-less tools return []", () => {
	assert.deepEqual(extractPaths("todo_write", { items: [] }).paths, []);
	assert.deepEqual(extractPaths("ask_user", { questions: [] }).paths, []);
});
