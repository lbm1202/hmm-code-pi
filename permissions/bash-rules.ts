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
//
// Pattern note: `"ls *"` matches "ls<space>anything" but NOT bare `ls`.
// Commands often used with no args (ls, pwd, whoami, …) need BOTH entries —
// bare form + `* ` form — to be allowed in both invocations.

import type { Verdict } from "./types";

export const BASH_DEFAULT: Record<string, Verdict> = {
	"*": "ask",
	// Read-only / inspect — both bare and with-args forms.
	"cat *": "allow",
	"head *": "allow",
	"tail *": "allow",
	"less *": "allow",
	"ls": "allow",
	"ls *": "allow",
	"tree": "allow",
	"tree *": "allow",
	"pwd": "allow",
	"pwd *": "allow",
	"echo": "allow",
	"echo *": "allow",
	"wc *": "allow",
	"which *": "allow",
	"type *": "allow",
	"file *": "allow",
	"diff *": "allow",
	"du": "allow",
	"du *": "allow",
	"df": "allow",
	"df *": "allow",
	"date": "allow",
	"date *": "allow",
	"uname": "allow",
	"uname *": "allow",
	"whoami": "allow",
	"whoami *": "allow",
	"printenv": "allow",
	"printenv *": "allow",
	"env": "allow",
	"env *": "allow",
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
	"tsc": "allow",
	"tsc *": "allow",
	"tsgo": "allow",
	"tsgo *": "allow",
	"tar *": "allow",
	"unzip *": "allow",
	"gzip *": "allow",
	"gunzip *": "allow",
	// Shell metacharacters — even in "full shell" modes, never auto-allow
	// a chain that an allowed prefix (`cat *`) would otherwise silently
	// launch a denied suffix (`| rm -rf /`) through. We downgrade these to
	// ask (not deny) since code/debug legitimately use pipes/redirects all
	// the time — the user gets one confirm per composed command instead of
	// fully blocking. Last-match-wins means this trumps earlier allows.
	"*\n*": "ask",
	"*<(*": "ask",
	"*|*": "ask",
	"*;*": "ask",
	"*&&*": "ask",
	"*||*": "ask",
	"*$(*": "ask",
	"*`*": "ask",
	"*>*": "ask",
	"* > *": "ask",
	"*>>*": "ask",
	"* >> *": "ask",
	"*>|*": "ask",
	"* >| *": "ask",
};

export const BASH_READ_ONLY: Record<string, Verdict> = {
	"*": "deny",
	// Read-only / inspect (same allow set as default, minus the mutators).
	// Both bare and with-args forms — see pattern note at top.
	"cat *": "allow",
	"head *": "allow",
	"tail *": "allow",
	"less *": "allow",
	"ls": "allow",
	"ls *": "allow",
	"tree": "allow",
	"tree *": "allow",
	"pwd": "allow",
	"pwd *": "allow",
	"echo": "allow",
	"echo *": "allow",
	"wc *": "allow",
	"which *": "allow",
	"type *": "allow",
	"file *": "allow",
	"diff *": "allow",
	"du": "allow",
	"du *": "allow",
	"df": "allow",
	"df *": "allow",
	"date": "allow",
	"date *": "allow",
	"uname": "allow",
	"uname *": "allow",
	"whoami": "allow",
	"whoami *": "allow",
	"printenv": "allow",
	"printenv *": "allow",
	"env": "allow",
	"env *": "allow",
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
	// catch-all `git *: deny`. Bare forms (`git status`) and with-args forms
	// (`git status -s`) both listed — see pattern note at top.
	"git *": "deny",
	"git log": "allow",
	"git log *": "allow",
	"git show": "allow",
	"git show *": "allow",
	"git diff": "allow",
	"git diff *": "allow",
	"git status": "allow",
	"git status *": "allow",
	"git blame *": "allow",
	"git rev-parse *": "allow",
	"git rev-list *": "allow",
	"git ls-files": "allow",
	"git ls-files *": "allow",
	"git ls-tree *": "allow",
	"git ls-remote": "allow",
	"git ls-remote *": "allow",
	"git shortlog": "allow",
	"git shortlog *": "allow",
	"git describe": "allow",
	"git describe *": "allow",
	"git cat-file *": "allow",
	"git name-rev *": "allow",
	"git stash list": "allow",
	"git stash list *": "allow",
	"git tag -l": "allow",
	"git tag -l *": "allow",
	"git branch --list": "allow",
	"git branch --list *": "allow",
	"git branch -a": "allow",
	"git branch -a *": "allow",
	"git branch -r": "allow",
	"git branch -r *": "allow",
	"git remote -v": "allow",
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
