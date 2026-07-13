# Permission system

Every LLM tool call (`read` / `edit` / `write` / `bash` / …) is evaluated and assigned one of `allow` / `ask` / `deny`. Kilo Code's model, ported onto Pi's `tool_call` hook.

While `modes.json`'s `activeTools` controls **which tools the LLM even sees** for a given mode (Layer 1), the permission system controls **what those tools may touch** (Layer 2). The two layers are orthogonal.

---

## 1. Evaluation layers (lowest → highest precedence)

```
BASE_DEFAULTS                                              (code)
  └─ MODE_DEFAULTS[currentMode]                            (code)
       └─ ~/.pi/agent/modes.json:permissions               (global user — canonical)
       └─ (fallback) ~/.pi/agent/permissions.json          (legacy standalone — pre-consolidation installs)
            └─ ${cwd}/.pi/permissions.json                 (project user)
                 └─ ${cwd}/.piignore                       (unconditional deny — separate layer)
```

> Global permissions live **inside `modes.json` under the `permissions` key** — one file holds the entire mode + permission config. If an older standalone `permissions.json` is present, it's loaded as a fallback to keep existing installs working. To consolidate, move its contents into `modes.json:permissions` and delete `permissions.json`.

Within a single layer: **last-match wins** (Kilo semantics). Rules are walked in object-key order; the last matching verdict is the layer's verdict.

Across layers: **strongest wins** — `deny > ask > allow`. Any layer's `deny` wins outright; any `ask` survives unless trumped by `deny`.

`.piignore` matches short-circuit to `deny` regardless of other layers.

---

## 2. Built-in defaults

### Base (all modes)

```jsonc
{
  "rules": {
    "read": {
      "**": "allow",
      "*.env":            "ask",
      "**/*.env":         "ask",
      "*.env.*":          "ask",
      "**/*.env.*":       "ask",
      "*.env.example":    "allow",
      "**/*.env.example": "allow"
    },
    "edit":  { "**": "allow" },
    "write": { "**": "allow" },
    "bash":  BASH_DEFAULT    // ↓
  },
  "external_directory": {
    "**":           "ask",
    "/tmp/**":      "allow",
    "~/.pi/**":     "allow"
  }
}
```

> Why `**` instead of `*`: path-mode glob `*` is single-segment (`[^/]*`), so `*: ask` would silently miss any nested path like `src/.env` or `/etc/passwd`. `**` (`.*`) is recursive and matches across slashes — closing that gap.

### `BASH_DEFAULT` (code / debug / review modes)

`*: ask` plus an allowlist for ~30 safe commands. Anything not in the allow list (`rm`, `sudo`, `curl | sh`, `npm install`, `git push`, etc.) becomes `ask`.

| Category | Allow patterns |
|---|---|
| Inspect files | `cat *`, `head *`, `tail *`, `less *`, `ls` + `ls *`, `tree` + `tree *`, `pwd` + `pwd *`, `echo` + `echo *` |
| Search / filter | `grep *`, `rg *`, `ag *`, `sort *`, `uniq *`, `cut *`, `tr *`, `jq *`, `wc *`, `which *`, `type *`, `file *`, `diff *` |
| System info | `du` + `du *`, `df` + `df *`, `date` + `date *`, `uname` + `uname *`, `whoami` + `whoami *`, `printenv` + `printenv *`, `env` + `env *`, `man *` |
| Common mutators | `touch *`, `mkdir *`, `cp *`, `mv *`, `tsc` + `tsc *`, `tsgo` + `tsgo *`, `tar *`, `unzip *`, `gzip *`, `gunzip *` |
| Shell metacharacters | `*|*`, `*;*`, `*&&*`, `*||*`, `*$(*`, `` *`* ``, `*>*`, `*>>*`, `*<(*`, `*\n*`, `* > *`, `* >> *`, `*>|*`, `* >| *` — all `ask` (so `cat foo | rm` doesn't slip through under the `cat *` allow) |

> Commands often used with no args (`ls`, `pwd`, `git status`, …) have *both* bare and `* `-suffixed entries because path-mode glob `*` requires a space. Without the bare entry, `ls` (no args) would fall through to `*: ask`.

### `BASH_READ_ONLY` (plan / ask modes)

`*: deny` + read-only commands explicit allow + **shell metacharacters hard deny**.

| Category | Rule |
|---|---|
| Default | `*: deny` |
| Same read-only allows as BASH_DEFAULT | |
| git read-only | `git *: deny` then re-allow `git log/show/diff/status/blame/rev-parse/ls-files/...` (bare + with-args) |
| Shell metacharacters | `*|*`, `*;*`, `*&&*`, `*&*`, `*$(*`, `` *`* ``, `*>*`, `*>>*`, `*<(*` — all `deny` |
| `sort -o` | `sort -o *`, `sort * -o *`, `sort --output*` — `deny` (file write) |

### Per-mode overrides

```ts
code:  {} // base as-is
plan:  {
  rules: {
    bash:  BASH_READ_ONLY,
    edit:  { "**": "deny", ".pi/plans/*.md": "allow", ".pi/plans/**/*.md": "allow" },
    write: { "**": "deny", ".pi/plans/*.md": "allow", ".pi/plans/**/*.md": "allow" }
  }
}
debug: {} // base as-is (debug needs free shell)
ask:   {
  rules: {
    bash:  BASH_READ_ONLY,
    edit:  { "**": "deny" },
    write: { "**": "deny" }
  }
}
review: {
  rules: {
    // bash inherits base BASH_DEFAULT — review must RUN the plan's
    // validation commands (tests, builds, smoke launches), like debug.
    edit:  { "**": "deny" },
    write: { "**": "deny" }
  }
}
```

> Note: plan/ask/review `activeTools` already exclude edit/write from the LLM, so the `edit: deny` / `write: deny` rules are defense-in-depth — they catch the case where a user manually adds edit/write to those modes' `activeTools`.

---

## 3. User config

### Global: `~/.pi/agent/modes.json` under the `permissions` key

Permission rules live in the same file as mode config. On first run, `modes.example.json` is generated with a `permissions` section as a template; copy it to `modes.json` and edit.

A standalone `~/.pi/agent/permissions.json` is also still loaded as a fallback (for pre-consolidation installs). When both exist, `modes.json:permissions` wins.

### Project: `${cwd}/.pi/permissions.json`

Lives in the project directory. Overrides the global rules.

### Schema

```jsonc
{
  "rules": {
    "read":  { "<pattern>": "allow" | "ask" | "deny", ... },
    "edit":  { ... },
    "write": { ... },
    "bash":  { ... }
  },
  "external_directory": {
    "<absolute or ~ pattern>": "allow" | "ask" | "deny"
  },
  "modes": {
    "plan":   { /* same shape — overrides for this mode only */ },
    "code":   { ... },
    "debug":  { ... },
    "ask":    { ... },
    "review": { ... }
  }
}
```

---

## 4. Glob syntax

**File path (read / edit / write)**: gitignore-style
- `*` any chars within one path segment (no `/`)
- `**` recursive (matches `/`)
- `?` single char (not `/`)
- `[abc]` character class
- `~/` home expansion (in `external_directory` patterns)
- Leading `/` (`/etc/...`) or relative (`src/...`)

**Bash command**: shell mode (`*` crosses `/`)
- `*` any chars (slash included)
- `**` same
- `"rm *"` matches both `rm /tmp/foo` and `rm -rf node_modules`

For bash commands, the evaluator additionally extracts absolute-path tokens (`/abs`, `~/path`) and runs them through `external_directory` rules — so `bash "cat /etc/passwd"` is caught by `external_directory: {"**": "ask"}` even though no bash pattern mentions `/etc`.

---

## 5. `.piignore` (gitignore-style)

A `.piignore` at the workspace root denies any file matching the patterns for **every tool**. Trumps the regular permission layers.

```
# comment
secrets/
*.key
*.pem
*.db
*.sqlite

# negation (allowlist override)
!secrets/public.json
```

- Directory patterns (trailing `/`) match the directory and everything inside.
- Independent from `.gitignore`.
- No global `.piignore` — use the `deny` rules in `modes.json:permissions` for global blocks.

> Absolute paths outside the workspace are skipped (no `.piignore` could meaningfully apply). Use `external_directory: { "/path/**": "deny" }` for those.

---

## 6. Auto-approve (session toggle)

Binary toggle that auto-passes any `ask` verdict. Session-scoped — resets to OFF on every `session_start`.

**How to toggle**:
- **CLI slash**: `/auto-approve` (toggle) / `/auto-approve on` / `/auto-approve off`
- **TUI shortcut**: `Ctrl+Shift+A`
- **VS Code**: footer "🔒 Auto" button (turns 🔓 + orange when on). The keyboard combo doesn't work in the webview (VS Code intercepts it) — use the button.

**Never persisted by design** — keeping it permanently ON would defeat the permission system. For permanent rule changes, edit `modes.json:permissions` directly (flip `"ask"` to `"allow"`).

Toggling mid-turn takes effect immediately (next `tool_call`). Slash commands aren't queued during a streaming response (Pi's `agent-session.js:689`). Dialogs already on screen still need to be answered manually — auto-dismissing them would be more confusing than helpful.

---

## 7. Common recipes

### Protect secrets / keys
```jsonc
{
  "rules": {
    "read": {
      "*.key": "deny",
      "**/*.key": "deny",
      "*.pem": "deny",
      "**/*.pem": "deny",
      "id_rsa*": "deny",
      "*.sqlite": "ask"
    }
  }
}
```

### Block system directories
```jsonc
{
  "external_directory": {
    "/etc/**": "deny",
    "/var/**": "deny",
    "~/.ssh/**": "deny",
    "~/.aws/**": "deny"
  }
}
```

### Allow a specific external dir in one project
```jsonc
// ${cwd}/.pi/permissions.json
{
  "external_directory": {
    "~/Dev/shared-lib/**": "allow"
  }
}
```

### Force-ask risky bash commands
```jsonc
{
  "rules": {
    "bash": {
      "rm -rf *": "ask",
      "sudo *":   "ask",
      "curl * | sh":   "deny",
      "curl * | bash": "deny",
      "npm install *": "ask",
      "git push *":    "ask",
      "git reset --hard*": "ask"
    }
  }
}
```

### Auto-allow test commands in debug mode only
```jsonc
{
  "modes": {
    "debug": {
      "rules": {
        "bash": {
          "pytest *":   "allow",
          "npm test *": "allow",
          "go test *":  "allow"
        }
      }
    }
  }
}
```

### Edit only one directory in a monorepo
```jsonc
// ${cwd}/.pi/permissions.json
{
  "rules": {
    "edit": {
      "**": "deny",
      "packages/my-pkg/**": "allow",
      "packages/my-pkg/dist/**": "deny"
    }
  }
}
```

---

## 8. Per-tool path extraction

What gets matched against the rules per tool:

| Tool | Path source | Rule key |
|---|---|---|
| `read` | `input.path` | `read` |
| `edit` | `input.path` | `edit` |
| `write` | `input.path` | `write` |
| `multi_edit` | `input.path` + each `edits[].path` (all evaluated — any deny blocks) | `edit` |
| `grep` | `input.path` (search root) | `read` |
| `find` | `input.path` | `read` |
| `ls` | `input.path` | `read` |
| `bash` | none for the rule itself; `input.command` for the bash ruleset + extracted absolute paths fed to `external_directory` | `bash` (+ `external_directory`) |

---

## 9. External-directory evaluation

Absolute paths outside the workspace `cwd` run through both the regular tool rules and the `external_directory` rules — strongest wins. So `external_directory: { "**": "ask" }` puts a confirm on every read/edit/write outside `cwd`.

Auto-allowlisted:
- `/tmp/**` — Pi uses tmp a lot
- `~/.pi/**` — Pi's own home

---

## 10. Headless environments

When `!ctx.hasUI` (CI / background RPC), an `ask` verdict becomes an **automatic deny** so the run doesn't hang waiting for input that will never come. Error message: `"... (headless session — cannot prompt; configure permissions.json to allow)"`.

For CI automation, either bake the rule as `"allow"` ahead of time, or send `/auto-approve on` once at session start.

---

## 11. Troubleshooting

### A new rule doesn't take effect
1. JSON parse error — failures surface as `[modes:permissions] failed to parse <path>: ...` on stderr.
2. Pi hasn't reloaded — send `/reload-runtime` (CLI) or save anything in the VS Code settings panel (triggers `reloadAll` automatically).
3. Confirm the last matching rule is what you think — with last-match-wins, put catch-alls high and specific rules low; the reverse is the trap.

### Bash rule doesn't match
- Slash-containing commands aren't matched by path-mode glob. The evaluator auto-switches to shell mode for bash, so `*` crosses `/`.
- `"rm *"` matches `rm /tmp/foo`. If it doesn't match, suspect a typo in the rule key.

### Plan mode denies a routine command
- `BASH_READ_ONLY` denies anything containing shell metacharacters — `cat file | grep foo` won't run.
- Intentional (it's the escape-hatch guard). If you really need it, switch to `code` or relax via `${cwd}/.pi/permissions.json` mode override.

### `.piignore` seems ignored
- Only the workspace-root `.piignore` is loaded (sub-directory `.piignore` files aren't read in the current version).
- Trailing `/` matches directories only. Drop the `/` if you want files matched too.
- Absolute paths outside `cwd` are skipped — use `external_directory` rules for those.
