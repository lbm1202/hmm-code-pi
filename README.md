<div align="center">

<img src="media/icon.png" alt="Hmm-code" width="128" />

# Hmm-code (Pi extension)

**Multi-mode wrapper for the [Pi coding agent](https://github.com/badlogic/pi-mono).**
Four explicit modes — `plan` / `code` / `debug` / `ask` — with independent model, thinking, tools, and system prompt.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi-coding-agent](https://img.shields.io/badge/Pi-0.77.x-purple.svg)](https://github.com/badlogic/pi-mono)
[![Bundled in](https://img.shields.io/badge/bundled%20in-hmm--code--vscode-blue.svg)](https://github.com/lbm1202/hmm-code-vscode)

[Install](#install-standalone) · [Modes](#modes) · [Slash commands](#slash-commands) · [Docs](#docs)

</div>

---

> **VS Code users**: don't install this directly. The companion [hmm-code-vscode](https://github.com/lbm1202/hmm-code-vscode) extension bundles it inside the `.vsix` and loads it via the `-e` flag — you get it for free. Install standalone only if you drive Hmm-code from the Pi TUI, or you're developing this extension.

**Core invariant**: every code-modifying path must go `plan → code`. The other modes (`debug` / `ask`) only enrich the context that feeds into `plan`.

---

## Features

| | |
|---|---|
| 🎭 **Four modes** | `plan` / `code` / `debug` / `ask` — per-mode model, thinking level, active tools, system prompt |
| 📐 **`finalize_plan`** | Plan → code handoff (new session / current session / revise — 3-way dialog). Schema: `summary` + `body` + `steps` + `validation` + `docs?` |
| 🔀 **`request_mode_switch`** | LLM proposes a mode switch → user confirms → auto-apply (with carry-over context) |
| 🛡️ **Permission system** | Kilo-aligned `tool_call` hook — `modes.json:permissions` + `.piignore`, layered with `allow` / `ask` / `deny` |
| 🔓 **Auto-approve** | Session-scoped toggle — `ask` verdicts pass through (CLI slash + VS Code button + `Ctrl+Shift+A`) |
| 📚 **AGENTS.md injection** | `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md` auto-appended to the system prompt |
| 🩹 **Tool-call name sanitizer** | Repairs mangled tool names from local models (Qwen vLLM, etc.) — prevents codex hard-stuck |
| ✨ **Auto-titles** | First message pair → GPT-mini → session title (fire-and-forget) |
| 📦 **Auto-compact** | Triggers at 75% context window usage |

---

## Install (standalone)

Skip this if you're already using `hmm-code-vscode` — the .vsix bundles this extension already.

### From git (manual)
```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lbm1202/hmm-code-pi.git ~/.pi/agent/extensions/hmm-code-pi
```
Pi auto-loads it on next start. Update with `git pull`.

### Via `pi install`
```bash
pi install https://github.com/lbm1202/hmm-code-pi
# Or from a local clone:
pi install ./path/to/hmm-code-pi
```
Update with `pi update hmm-code-pi`.

> `pi install npm:hmm-code-pi` will work once the package is published to npm — not yet.

### First-run side effects

The extension writes these files on first load (idempotent):
- `~/.pi/agent/modes.example.json` — mode config template (includes a `permissions` section)
- `~/.pi/agent/keybindings.json` — frees `Shift+Tab` for autocomplete; moves Pi's thinking-cycle to `Ctrl+Shift+T`
- `~/.pi/agent/settings.json` — `quietStartup`, `hideThinkingBlock`

---

## Modes

| Mode  | LLM tools (configurable) | Auto-injected | Permission layer 2 | Purpose |
|-------|--------------------------|---------------|-------------------|---------|
| 🔵 **plan**  | read, grep, find, ls, bash | ask_user, request_mode_switch, **finalize_plan** | bash → read-only; edit/write `.pi/plans/*.md` only | Research + design + finalize_plan |
| ⚪ **code**  | read, edit, write, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | Base defaults (safe bash allow, dangerous ask) | Actual code authoring |
| 🟣 **debug** | read, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | Base defaults (debug needs free shell) | Reproduce + diagnose + verify hypotheses |
| 🟠 **ask**   | read, grep | ask_user, request_mode_switch | bash → read-only; edit/write deny | Explain + Q&A |

`edit` / `write` are auto-stripped from `plan` / `debug` / `ask` `activeTools` — adding them in `modes.json` is silently ignored with a warning.

Workflow diagram + handoff details: [docs/WORKFLOW.md](docs/WORKFLOW.md).

---

## Slash commands

| Command | Description |
|---|---|
| `/mode [name]` | Picker (no arg) or direct switch |
| `/mode-set` | Interactive per-mode model + thinking editor (auto-reloads) |
| `/plan-execute` | Run the most recent plan in a new child session |
| `/reset` | Restore model + thinking to the current mode's default (same as `Alt+X`) |
| `/auto-approve [on\|off]` | Session-scoped bypass for permission `ask` (same as `Ctrl+Shift+A`) |
| `/thinking-toggle` | Toggle thinking level (binary for Qwen-style, cycle otherwise) — same as `Alt+T` |
| `/reload-runtime` | Reload extensions / settings / models (RPC-safe replacement for Pi's built-in `/reload`) |

---

## TUI keybindings

| Key | Action |
|---|---|
| `Tab` / `Ctrl+Alt+M` | Cycle mode (code → plan → debug → ask) |
| `Alt+T` | Toggle thinking level (provider-aware) |
| `Alt+X` | Reset model + thinking to the current mode's default |
| `Ctrl+Shift+A` | Toggle auto-approve (session-scoped) |

`Shift+Tab` is reassigned to Pi's autocomplete by this extension (via `keybindings.json`).

`Alt+T` semantics:
- Qwen-style binary providers (`qwen-chat-template`, `qwen`, `zai`): off ↔ last non-off level
- Reasoning models (GPT-5, Claude, etc.): off → minimal → low → medium → high → xhigh → off

---

## Docs

| | |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Mode transitions, `finalize_plan`, deferred dispatch, session lifecycle |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Permission system end-to-end — rules, builtins, user config, examples |
| [docs/AGENTS-MD.md](docs/AGENTS-MD.md) | AGENTS.md auto-injection mechanism |
| [docs/ANALYSIS.md](docs/ANALYSIS.md) | File-by-file architecture deep-dive |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

---

## Config files

| Path | Contents |
|---|---|
| `~/.pi/agent/modes.json` | Per-mode model / thinking / activeTools / systemPromptAddendum / temperature / chatTemplate, modelAliases, autoTitle model, modelAllowlist, **permissions** |
| `${cwd}/.pi/permissions.json` | Project-level permission overrides (overrides the global rules) |
| `${cwd}/.piignore` | gitignore-style hard block (denied for every tool) |
| `${cwd}/AGENTS.md` | Project context (auto-injected into the system prompt) |
| `~/.pi/agent/AGENTS.md` | Global context |
| `~/.pi/agent/plans/` | `finalize_plan` output |

> `~/.pi/agent/permissions.json` is the legacy global location — still loaded as a fallback when present, but prefer the `permissions` section inside `modes.json`.

---

## Core invariants

1. **`edit` / `write` are code-only.** Auto-stripped from `plan` / `debug` / `ask` `activeTools` (`state.ts:PROTECTED_FROM_NON_CODE`).
2. **`finalize_plan` is plan-only.** The sole explicit entry to code mode.
3. **`request_mode_switch("code")` is blocked.** Code mode is reached only via `finalize_plan`.
4. **External paths still hit the permission layer.** `~/.ssh`, `/etc`, etc. need `ask` or `deny` per `external_directory` rules.

---

## Layout

```
<extension root>/
├── index.ts             entry — builds the Runtime, registers tools/commands/shortcuts/hooks
├── config.ts            mode schema + loadModes + DEFAULT_MODES (system prompts)
├── constants.ts         STATUS_KEYS, AUTO_COMPACT_THRESHOLD, version/author single source
├── runtime.ts           shared Runtime context (editor ref + footer invalidator)
├── ui.ts                ANSI / banner helpers, mixed-case "Hmm" glyph table
├── plans.ts             ~/.pi/agent/plans/ path + unique name generation
├── config-io.ts         modes.json / keybindings.json / settings.json I/O
├── state.ts             ModeState (apply / reset / footer), pushStatus for RPC clients
├── commands.ts          /mode, /mode-set, /plan-execute, /reset, /reload-runtime, /auto-approve, /thinking-toggle
├── shortcuts.ts         Tab, Ctrl+Alt+M, Alt+T, Alt+X, Ctrl+Shift+A
├── hooks.ts             session_start, before_agent_start (AGENTS.md), before_provider_request, agent_end
├── ask-user.ts          multi-question card tool
├── request-mode-switch.ts   mode-switch proposal (carry-over deferred)
├── finalize-plan.ts     plan commit + 3-way dialog
├── todo.ts              OpenCode/Kilo-style todo_write
├── auto-title.ts        first message pair → GPT-mini → session title
└── permissions/         permission system — see docs/PERMISSIONS.md
    ├── index.ts         tool_call hook + evaluation entrypoint
    ├── defaults.ts      BASE_DEFAULTS + MODE_DEFAULTS
    ├── bash-rules.ts    BASH_DEFAULT + BASH_READ_ONLY (Kilo MIT-licensed patterns)
    ├── evaluator.ts     layer merge + strongest verdict
    ├── glob.ts          lightweight minimatch (path mode + shell mode)
    ├── piignore.ts      .piignore parser
    ├── extract-paths.ts per-tool path extraction
    ├── loader.ts        JSON disk loader (mtime cache)
    └── types.ts         Verdict / Permissions / Ruleset schemas
```

Path is `~/.pi/agent/extensions/hmm-code-pi/` for the manual git-clone install, or wherever `pi install` placed it (`pi list` to check).

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [Pi coding agent](https://github.com/badlogic/pi-mono) — the agent runtime we extend
- [Kilo Code](https://github.com/Kilo-Org/kilocode) — permission-rule patterns and bash allowlist (MIT)
- [OpenCode](https://github.com/sst/opencode) — AGENTS.md format and `todo_write` schema
