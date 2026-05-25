// Bash command allow/ask/deny tables.
//
// Patterns and structure adapted from Kilo Code (MIT-licensed):
//   github.com/Kilo-Org/kilocode  packages/opencode/src/kilocode/agent/index.ts
//
// BASH_DEFAULT applies in modes that have full shell access (code/debug).
// Safe read-only + common utility commands auto-allow; everything else asks.
//
// BASH_READ_ONLY applies in read-only modes (plan/ask). Defaults to deny,
// allowlists only true read-only commands, and explicitly denies shell
// metacharacters (pipe / redirect / chain / subshell) so the LLM can't sneak
// a mutation through `cat … | tee …` or `… > file`.

import type { Verdict } from "./types";

export const BASH_DEFAULT: Record<string, Verdict> = {
	"*": "ask",
	// Read-only / inspect
	"cat *": "allow",
	"head *": "allow",
	"tail *": "allow",
	"less *": "allow",
	"ls *": "allow",
	"tree *": "allow",
	"pwd *": "allow",
	"echo *": "allow",
	"wc *": "allow",
	"which *": "allow",
	"type *": "allow",
	"file *": "allow",
	"diff *": "allow",
	"du *": "allow",
	"df *": "allow",
	"date *": "allow",
	"uname *": "allow",
	"whoami *": "allow",
	"printenv *": "allow",
	"man *": "allow",
	"grep *": "allow",
	"rg *": "allow",
	"ag *": "allow",
	"sort *": "allow",
	"uniq *": "allow",
	"cut *": "allow",
	"tr *": "allow",
	"jq *": "allow",
	// Frequent benign mutators (asking on every `mkdir` would be noise)
	"touch *": "allow",
	"mkdir *": "allow",
	"cp *": "allow",
	"mv *": "allow",
	"tsc *": "allow",
	"tsgo *": "allow",
	"tar *": "allow",
	"unzip *": "allow",
	"gzip *": "allow",
	"gunzip *": "allow",
};

export const BASH_READ_ONLY: Record<string, Verdict> = {
	"*": "deny",
	// Read-only / inspect (same allow set as default, minus the mutators)
	"cat *": "allow",
	"head *": "allow",
	"tail *": "allow",
	"less *": "allow",
	"ls *": "allow",
	"tree *": "allow",
	"pwd *": "allow",
	"echo *": "allow",
	"wc *": "allow",
	"which *": "allow",
	"type *": "allow",
	"file *": "allow",
	"diff *": "allow",
	"du *": "allow",
	"df *": "allow",
	"date *": "allow",
	"uname *": "allow",
	"whoami *": "allow",
	"printenv *": "allow",
	"man *": "allow",
	"grep *": "allow",
	"rg *": "allow",
	"ag *": "allow",
	"sort *": "allow",
	"uniq *": "allow",
	"cut *": "allow",
	"tr *": "allow",
	"jq *": "allow",
	// git: blanket deny, then re-allow only the introspection subcommands.
	// Last-match-wins means the more specific git rules below override the
	// catch-all `git *: deny`.
	"git *": "deny",
	"git log *": "allow",
	"git show *": "allow",
	"git diff *": "allow",
	"git status *": "allow",
	"git blame *": "allow",
	"git rev-parse *": "allow",
	"git rev-list *": "allow",
	"git ls-files *": "allow",
	"git ls-tree *": "allow",
	"git ls-remote *": "allow",
	"git shortlog *": "allow",
	"git describe *": "allow",
	"git cat-file *": "allow",
	"git name-rev *": "allow",
	"git stash list *": "allow",
	"git tag -l *": "allow",
	"git branch --list *": "allow",
	"git branch -a *": "allow",
	"git branch -r *": "allow",
	"git remote -v *": "allow",
	// Shell metacharacters — block escape hatches that could turn a "read"
	// command into a write (pipe to tee, redirect to file, chain rm, etc.)
	"*\n*": "deny",
	"*<(*": "deny",
	"*|*": "deny",
	"*;*": "deny",
	"*&&*": "deny",
	"*&*": "deny",
	"*$(*": "deny",
	"*`*": "deny",
	"*>*": "deny",
	"* > *": "deny",
	"*>>*": "deny",
	"* >> *": "deny",
	"*>|*": "deny",
	"* >| *": "deny",
	// `sort -o` writes to a file — block all forms.
	"sort -o *": "deny",
	"sort * -o *": "deny",
	"sort --output*": "deny",
	"sort * --output*": "deny",
};
