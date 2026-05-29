# AGENTS.md

[`AGENTS.md`](https://agents.md/) is an open format adopted by OpenCode, Kilo Code, and others — a "README for the agent". One markdown file that captures build/test commands, conventions, gotchas — the project context an LLM should know — and the tool injects it into the system prompt automatically.

This extension implements the same mechanism. **Not opt-in — auto-discovered and auto-injected.**

---

## 1. File locations

| Location | Purpose | Precedence |
|---|---|---|
| `${cwd}/AGENTS.md` | Per-project | High (overrides global) |
| `~/.pi/agent/AGENTS.md` | Global (shared across projects) | Low |

When both exist, the system prompt is `... + global + project`. LLMs weight later instructions more heavily, so listing project last gives natural override semantics.

---

## 2. How it works

On every `before_agent_start` hook (= one user prompt cycle start):

```ts
sections = [event.systemPrompt];
if (modeAddendum)  sections.push(`## Active mode: ${mode}\n${addendum}`);
if (agents.global) sections.push(`## Global AGENTS.md\n${agents.global}`);
if (agents.project) sections.push(`## Project AGENTS.md (${agents.projectPath})\n${agents.project}`);
return { systemPrompt: sections.join("\n\n") };
```

- Re-read from disk every cycle (small files, fs cache makes it cheap).
- Edits take effect on the next user prompt — no reload required.
- Reaches the LLM as part of the system prompt (not a separate message).

---

## 3. Recommended contents

### Example: `${cwd}/AGENTS.md`

```markdown
# Project context for AI coding agents

## Build & test
- `npm install` — dependencies
- `npm run build` — production build (out/)
- `npm test` — run jest suite
- `npm run lint` — eslint + prettier check

## Architecture
- `src/api/` — Express routes, REST contract docs in `docs/openapi.yaml`
- `src/services/` — business logic (no DB or HTTP knowledge)
- `src/db/` — Prisma client + migrations
- `webview/` — separate esbuild bundle, no Node imports

## Conventions
- Imports: external first, then `@/` aliases, then relative
- Tests live alongside source as `*.test.ts`
- Public API changes need a changeset (`npx changeset`)

## Gotchas
- Don't `npm install` — this repo uses `pnpm`. Run `pnpm i` instead.
- `prisma generate` after every schema change
- E2E tests need `docker-compose up -d` first
```

### Example: `~/.pi/agent/AGENTS.md`

```markdown
# Personal preferences (all projects)

- Don't add comments unless something is genuinely non-obvious.
- Prefer existing utilities over adding new dependencies.
- Avoid `any` in TypeScript — use `unknown` if the type is truly opaque.
- Keep PRs small (< 300 lines diff).
- Commit messages: imperative mood, lowercase first letter, no trailing period.
```

---

## 4. Compatibility with other tools

| Tool | AGENTS.md recognized |
|---|---|
| OpenCode | ✓ (AGENTS.md wins over CLAUDE.md when both exist) |
| Kilo Code | ✓ (filename must be uppercase) |
| Cursor | Recently added |
| Claude Code (Anthropic CLI) | Uses `CLAUDE.md` instead — does not auto-pick up AGENTS.md |
| Pi core (without this extension) | Not recognized |
| **This extension (hmm-code)** | ✓ — same precedence as opencode / kilo |

---

## 5. What we don't do

- **Nested AGENTS.md in monorepos** — Kilo's `Read` tool lazy-injects the directory's `AGENTS.md` when a subdirectory file is accessed. We don't do that. Add later if needed.
- **CLAUDE.md fallback** — no dual-recognition like Kilo / OpenCode. Just use AGENTS.md.
- **AGENTS.md write protection** — Kilo prevents the LLM from editing AGENTS.md. We don't enforce that; add it to your permission rules if you want it:
  ```jsonc
  {
    "rules": {
      "edit":  { "AGENTS.md": "ask" },
      "write": { "AGENTS.md": "ask" }
    }
  }
  ```

---

## 6. Security considerations

`AGENTS.md` is part of the system prompt — instructions inside it are followed essentially as trusted. So:

- A `AGENTS.md` from an untrusted project is a potential prompt-injection vector.
- Skim AGENTS.md before the first run on a cloned-from-strangers repo.
- To disable auto-injection entirely, comment out the `readAgentsMd` call inside [`hooks.ts`](../hooks.ts) `before_agent_start`.

This extension intentionally has no opt-out toggle — consistent behavior was prioritized over flexibility. The one-line code-edit escape hatch is sufficient for the rare case.
