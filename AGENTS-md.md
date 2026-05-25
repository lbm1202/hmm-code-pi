# AGENTS.md

[`AGENTS.md`](https://agents.md/) 는 OpenCode / Kilo Code 등이 채택한
오픈 포맷 — "agent 를 위한 README". 빌드/테스트/컨벤션 등 LLM 이 알아야
할 프로젝트 컨텍스트를 마크다운 1장에 적어두면 도구가 자동으로 system
prompt 에 넣어줌.

이 확장도 같은 메커니즘을 구현. opt-in 아니라 **자동 발견 + 자동 주입**.

---

## 1. 파일 위치

| 위치 | 용도 | 우선순위 |
|---|---|---|
| `${cwd}/AGENTS.md` | 프로젝트별 | 높음 (글로벌 override) |
| `~/.pi/agent/AGENTS.md` | 글로벌 (모든 프로젝트 공통) | 낮음 |

둘 다 있으면 system prompt 끝에 글로벌 먼저, 프로젝트 나중. LLM 이 후반
지침을 더 잘 따르므로 자연스럽게 project override 효과.

---

## 2. 작동 방식

매 `before_agent_start` 훅 (= user prompt 1개 cycle 시작) 마다:

```ts
sections = [event.systemPrompt];
if (modeAddendum)  sections.push(`## Active mode: ${mode}\n${addendum}`);
if (agents.global) sections.push(`## Global AGENTS.md\n${agents.global}`);
if (agents.project) sections.push(`## Project AGENTS.md (${agents.projectPath})\n${agents.project}`);
return { systemPrompt: sections.join("\n\n") };
```

- 매 cycle 디스크에서 다시 읽음 (작은 파일이고 캐시 잘 받음)
- 파일 편집이 다음 user prompt 부터 즉시 반영 — reload 불필요
- LLM 한테는 system prompt 의 일부로 보임 (별도 메시지 아님)

---

## 3. 권장 내용

### 예시: `${cwd}/AGENTS.md`

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
- Don't `npm install` — uses `pnpm`. Run `pnpm i` instead.
- `prisma generate` after every schema change
- E2E tests need `docker-compose up -d` first
```

### 예시: `~/.pi/agent/AGENTS.md`

```markdown
# Personal preferences (all projects)

- Don't add comments unless something is genuinely non-obvious.
- Prefer existing utilities over adding new dependencies.
- Avoid `any` in TypeScript — use `unknown` if the type is truly opaque.
- Keep PRs small (< 300 lines diff).
- Commit messages: imperative mood, first letter lowercase, no period.
```

---

## 4. 다른 도구와의 호환

| 도구 | AGENTS.md 인식 |
|---|---|
| OpenCode | ✓ (CLAUDE.md 와 둘 다 있으면 AGENTS.md 우선) |
| Kilo Code | ✓ (대문자 파일명 필수) |
| Cursor | 지원 시작됨 |
| Claude Code (Anthropic CLI) | `CLAUDE.md` 별도 — AGENTS.md 자동 인식 X |
| Pi 본체 (our extension 없이) | 인식 X |
| **이 확장 (hmm-code)** | ✓ — opencode/kilo 와 동일 우선순위 |

---

## 5. 안 하는 것

- **모노레포 nested AGENTS.md (서브디렉터리 lazy 로딩)** — Kilo Code 는
  Read 도구가 서브디렉터리 파일을 접근할 때 그 디렉터리의 AGENTS.md 도
  lazy 주입. 우리는 미지원. 필요하면 추후 추가.
- **CLAUDE.md fallback** — Kilo/OpenCode 처럼 둘 다 인식하는 모드 없음.
  사용자가 AGENTS.md 만 쓰는 게 자연스러움.
- **AGENTS.md write-protection** — Kilo 는 LLM 이 AGENTS.md 를 함부로
  수정 못 하게 막음. 우리는 권한 시스템 (permissions.json 의 edit deny
  룰) 에 사용자가 직접 추가하면 됨:
  ```jsonc
  {
    "rules": {
      "edit":  { "AGENTS.md": "ask" },
      "write": { "AGENTS.md": "ask" }
    }
  }
  ```

---

## 6. 보안 고려

`AGENTS.md` 도 system prompt 의 일부 — 그 안에 적힌 지시문은 LLM 이
거의 신뢰해서 따름. 따라서:

- 신뢰할 수 없는 프로젝트의 `AGENTS.md` 는 잠재적 prompt injection 매개체
- 모르는 repo clone 후 첫 실행 전에 한 번 훑어보는 게 안전
- 만약 항상 자동 주입을 원하지 않는다면 코드 수정으로 끄는 방법:
  [`hooks.ts`](hooks.ts) 의 `before_agent_start` 안의 `readAgentsMd`
  호출 조건을 바꾸기

이 확장은 의도적으로 opt-out 메커니즘을 제공하지 않음 — 일관된 동작이
중요하다는 판단. 대신 위 코드 한 줄만 주석 처리하면 끄기 가능.
