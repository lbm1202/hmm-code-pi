# Hmm-code (Pi extension)

Pi-side of **Hmm-code** — a multi-mode wrapper for the
[Pi coding agent](https://github.com/badlogic/pi-mono) (earendil-works/pi).
Adds four explicit modes — **plan / code / debug / ask** — with per-mode
model, thinking level, active tools, system-prompt addendum, temperature,
and chat template. All code-modifying paths go through `plan → code`.

For the VS Code UI that wraps `pi --mode rpc`, see the companion repo
[hmm-code-vscode](https://github.com/lbm1202/hmm-code-vscode).

## Modes

| Mode  | LLM tools (config)                       | Auto-injected                                  | Purpose                                                                |
|-------|------------------------------------------|------------------------------------------------|------------------------------------------------------------------------|
| plan  | read, grep, find, ls, bash               | ask_user, request_mode_switch, **finalize_plan** | Investigate read-only; design with `ask_user`; commit via `finalize_plan`. |
| code  | read, edit, write, bash, grep, find, ls  | ask_user, request_mode_switch, **todo_write** | Execute the handed-off plan. Only mode with write/edit.                |
| debug | read, bash, grep, find, ls               | ask_user, request_mode_switch, **todo_write** | Reproduce, inspect, hypothesize. No source mutation.                   |
| ask   | read, grep                               | ask_user, request_mode_switch                  | Concise explanations. Minimal tool use.                                |

`edit` and `write` are automatically stripped from plan/debug/ask via
`PROTECTED_FROM_NON_CODE` in `state.ts` — even if the user adds them to
`modes.json` by mistake.

## Installation

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lbm1202/hmm-code-pi ~/.pi/agent/extensions/modes
```

Pi loads it on next start. On first launch the extension self-installs
the required Pi `settings.json` / `keybindings.json` overrides
(`quietStartup`, `hideThinkingBlock`, Shift+Tab cycle, Alt+T thinking
toggle, etc.) and auto-reloads.

Per-mode config lives at `~/.pi/agent/modes.json`. If absent, the defaults
in `config.ts:DEFAULT_MODES` apply. A `modes.example.json` template is
also written on first run.

## Slash commands

- `/mode [name]` — open picker, or switch to a named mode directly.
- `/mode-set` — interactive editor for per-mode model + thinking level
  (loops until done, auto-reloads on exit).
- `/plan-execute` — launch the most recent (or pending) plan in a new
  child session (linked to the parent for picker-tree grouping).
- `/reset` — restore model + thinking to current mode's defaults
  (RPC counterpart of Alt+X).

## Shortcuts (TUI)

- `Shift+Tab` / `Ctrl+Alt+M` — cycle modes (code → plan → debug → ask).
- `Alt+T` — toggle thinking level. Provider-aware:
  - Qwen-style binary providers (`qwen-chat-template`, `zai`): off/on toggle.
  - Reasoning models (GPT-5, Claude, etc.): cycle off/minimal/low/medium/high.
- `Alt+X` — reset model + thinking to the current mode's defaults.

## Workflow

```
ask ─────────────────► request_mode_switch("plan", reason, summary)
                                                                    \
debug ───────────────► request_mode_switch("plan", reason, summary) ─► plan ─► finalize_plan ─► code
                                                                    /                       (new-session OR current-session)
plan ──────────────────────────────────────────────────────────────/
```

Plans saved at `~/.pi/agent/plans/plan-YYYYMMDD-<adjective>-<noun>.md`.
Handoff messages explicitly remind the model that it is no longer
read-only and that the plan is authoritative scope.

## Hard constraints

Plan / debug / ask modes cannot create, modify, or delete files — by any
means. This includes the obvious mutators (`edit`/`write` tools, bash
redirects, in-place editors, `rm/mv/cp/touch/chmod`, VCS state changes)
**and interpreter bypasses** (`python -c`, `python3 - <<HEREDOC`, `node -e`,
`ruby -e`, `perl -e` — even when the bash invocation itself looks
read-only, a runtime that internally calls `write_text`/`fs.writeFile`/
`open("w")` is a forbidden side-effect).

The constraint lives in two layers:

1. **Hard enforcement**: `setActiveTools` removes `edit`/`write` from
   plan/debug/ask. The tools literally aren't exposed to the LLM.
2. **Prompt enforcement**: the system-prompt addendum spells out the
   common bypass paths (bash redirects, in-place editors, interpreter
   heredocs, VCS state, package install). See `config.ts:DEFAULT_MODES`.

The only file write in plan mode is the plan markdown itself, which
`finalize_plan` writes via Node `fs.writeFileSync` (extension code runs
with full system permissions regardless of `setActiveTools`).

## Files

| File | Role |
|---|---|
| `index.ts` | Bootstrap. Wires runtime + tools + commands + shortcuts + hooks. |
| `config.ts` | Mode schema, `loadModes`, `DEFAULT_MODES` (system prompts). |
| `constants.ts` | `STATUS_KEYS`, `AUTO_COMPACT_THRESHOLD`, banner constants. Single source of truth for version + author. |
| `runtime.ts` | Shared `Runtime` context (editor ref + footer invalidator). |
| `ui.ts` | ANSI/banner rendering helpers, mixed-case "Hmm" glyph table. |
| `plans.ts` | `~/.pi/agent/plans/` path + unique name generator. |
| `config-io.ts` | `~/.pi/agent/{modes.json, keybindings.json, settings.json}` I/O. |
| `state.ts` | `ModeState` (apply/reset/footer-render), `pushStatus` for RPC clients. |
| `commands.ts` | `/mode`, `/mode-set`, `/plan-execute`, `/reset`. |
| `shortcuts.ts` | Shift+Tab, Ctrl+Alt+M, Alt+T, Alt+X. |
| `hooks.ts` | `session_start` (header/footer/editor), provider payload mutation, deferred dispatch for plan-handoff & mode-switch follow-ups. |
| `ask-user.ts` | Multi-question card tool. |
| `request-mode-switch.ts` | Permission-asking mode switch (carry-over deferred to `agent_end` to avoid stale model/tool capture). |
| `finalize-plan.ts` | Plan commit + 3-option dialog (new session / current session / revise). |
| `todo.ts` | OpenCode/Kilo-style `todo_write` task list. |
| `auto-title.ts` | First-turn session naming via a small GPT model (with `getApiKeyAndHeaders` auth resolve). |

See [`ANALYSIS.md`](ANALYSIS.md) for the per-file deep dive and
refactoring history.

## License

Personal use.
