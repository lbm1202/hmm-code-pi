<div align="center">

<img src="media/icon.png" alt="Hmm-code" width="128" />

# Hmm-code (Pi 확장)

**[Pi 코딩 에이전트](https://github.com/badlogic/pi-mono)를 위한 멀티모드 래퍼.**
네 개의 명시적 모드 — `plan` / `code` / `debug` / `ask` — 각각 독립된 모델, thinking, 도구, 시스템 프롬프트.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Pi-coding-agent](https://img.shields.io/badge/Pi-0.77.x-purple.svg)](https://github.com/badlogic/pi-mono)
[![Bundled in](https://img.shields.io/badge/bundled%20in-hmm--code--vscode-blue.svg)](https://github.com/lbm1202/hmm-code-vscode)

[English](README.md) · **한국어**

[설치](#독립-설치) · [모드](#모드) · [슬래시 명령](#슬래시-명령) · [문서](#문서)

</div>

---

> **VS Code 사용자**: 이걸 직접 설치하지 마세요. 동반 확장 [hmm-code-vscode](https://github.com/lbm1202/hmm-code-vscode)가 `.vsix` 안에 동봉해 `-e` 플래그로 로드합니다 — 그냥 따라옵니다. Pi TUI에서 Hmm-code를 직접 구동하거나 이 확장을 개발할 때만 독립 설치하세요.

**핵심 불변식**: 코드를 수정하는 모든 경로는 반드시 `plan → code` 를 거칩니다. 나머지 모드(`debug` / `ask`)는 `plan`에 들어가는 컨텍스트를 풍부하게 할 뿐입니다.

---

## 기능

| | |
|---|---|
| 🎭 **네 개의 모드** | `plan` / `code` / `debug` / `ask` — 모드별 모델, thinking 레벨, 활성 도구, 시스템 프롬프트 |
| 📐 **`finalize_plan`** | Plan → code 핸드오프 (새 세션 / 현재 세션 / 수정 — 3지선다 다이얼로그). 스키마: `summary` + `body` + `steps` + `validation` + `docs?` |
| 🔀 **`request_mode_switch`** | LLM이 모드 전환을 제안 → 사용자 확인 → 자동 적용 (carry-over 컨텍스트 포함) |
| 🛡️ **권한 시스템** | Kilo 정렬 `tool_call` 훅 — `modes.json:permissions` + `.piignore`, `allow` / `ask` / `deny` 레이어 |
| 🔓 **자동 승인** | 세션 단위 토글 — `ask` 판정을 통과 (CLI 슬래시 + VS Code 버튼 + `Ctrl+Shift+A`) |
| 📚 **AGENTS.md 주입** | `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md` 를 시스템 프롬프트에 자동 추가 |
| 🩹 **도구 호출 이름 살균** | 로컬 모델(Qwen vLLM 등)의 망가진 도구 이름 복구 — codex hard-stuck 방지 |
| ✨ **자동 제목** | 첫 메시지 쌍 → GPT-mini → 세션 제목 (fire-and-forget) |
| 📦 **다이나믹 압축** | 임계값을 넘으면 턴 도중이 아니라 턴 경계에서 컨텍스트 요약 (기본 75%, `modes.json:autoCompactThreshold`, 범위 50–85); `dynamicCompaction` 으로 토글. 수동 `/compact`. |

---

## 설치 (독립)

이미 `hmm-code-vscode`를 쓰고 있다면 건너뛰세요 — .vsix가 이 확장을 이미 동봉합니다.

### git에서 (수동)
```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lbm1202/hmm-code-pi.git ~/.pi/agent/extensions/hmm-code-pi
```
Pi가 다음 시작 시 자동 로드합니다. `git pull` 로 업데이트.

### `pi install` 로
```bash
pi install https://github.com/lbm1202/hmm-code-pi
# 또는 로컬 클론에서:
pi install ./path/to/hmm-code-pi
```
`pi update hmm-code-pi` 로 업데이트.

> `pi install npm:hmm-code-pi` 는 패키지가 npm에 게시되면 동작합니다 — 아직 아님.

### 첫 실행 부수효과

확장이 첫 로드 시 다음 파일들을 작성합니다 (멱등):
- `~/.pi/agent/modes.example.json` — 모드 설정 템플릿 (`permissions` 섹션 포함)
- `~/.pi/agent/keybindings.json` — 자동완성용으로 `Shift+Tab` 을 해제; Pi의 thinking-cycle을 `Ctrl+Shift+T` 로 이동
- `~/.pi/agent/settings.json` — `quietStartup`, `hideThinkingBlock`

---

## 모드

| 모드 | LLM 도구 (설정 가능) | 자동 주입 | 권한 레이어 2 | 목적 |
|-------|--------------------------|---------------|-------------------|---------|
| 🔵 **plan**  | read, grep, find, ls, bash | ask_user, request_mode_switch, **finalize_plan** | bash → 읽기 전용; edit/write는 `.pi/plans/*.md` 만 | 조사 + 설계 + finalize_plan |
| ⚪ **code**  | read, edit, write, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | 기본값 (안전 bash 허용, 위험은 ask) | 실제 코드 작성 |
| 🟣 **debug** | read, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | 기본값 (debug는 자유 셸 필요) | 재현 + 진단 + 가설 검증 |
| 🟠 **ask**   | read, grep | ask_user, request_mode_switch | bash → 읽기 전용; edit/write deny | 설명 + Q&A |

`edit` / `write` 는 `plan` / `debug` / `ask` 의 `activeTools` 에서 자동 제거됩니다 — `modes.json` 에 추가해도 경고와 함께 무시됩니다.

워크플로 다이어그램 + 핸드오프 상세: [docs/WORKFLOW.md](docs/WORKFLOW.md).

---

## 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/mode [name]` | 피커(인자 없음) 또는 직접 전환 |
| `/mode-set` | 모드별 모델 + thinking 인터랙티브 편집기 (자동 재로드) |
| `/plan-execute` | 최근 플랜을 새 자식 세션에서 실행 |
| `/reset` | 모델 + thinking을 현재 모드 기본값으로 복원 (`Alt+X` 와 동일) |
| `/auto-approve [on\|off]` | 권한 `ask` 세션 단위 우회 (`Ctrl+Shift+A` 와 동일) |
| `/thinking-toggle` | thinking 레벨 토글 (Qwen 계열은 binary, 그 외는 cycle) — `Alt+T` 와 동일 |
| `/reload-runtime` | 확장 / 설정 / 모델 재로드 (Pi 내장 `/reload`의 RPC 안전 대체) |
| `/compact` | 세션 컨텍스트를 지금 수동 압축 (VS Code 압축 버튼과 공유) |

---

## TUI 키바인딩

| 키 | 동작 |
|---|---|
| `Tab` / `Ctrl+Alt+M` | 모드 순환 (code → plan → debug → ask) |
| `Alt+T` | thinking 레벨 토글 (공급자 인식) |
| `Alt+X` | 모델 + thinking을 현재 모드 기본값으로 복원 |
| `Ctrl+Shift+A` | 자동 승인 토글 (세션 단위) |

`Shift+Tab` 은 이 확장이 Pi 자동완성으로 재할당합니다 (`keybindings.json` 경유).

`Alt+T` 의미:
- Qwen 계열 binary 공급자(`qwen-chat-template`, `qwen`, `zai`): off ↔ 마지막 비-off 레벨
- 추론 모델(GPT-5, Claude 등): off → minimal → low → medium → high → xhigh → off

---

## 문서

| | |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | 모드 전환, `finalize_plan`, 지연 디스패치, 세션 수명주기 |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 권한 시스템 전체 — 규칙, 빌트인, 사용자 설정, 예시 |
| [docs/AGENTS-MD.md](docs/AGENTS-MD.md) | AGENTS.md 자동 주입 메커니즘 |
| [CHANGELOG.md](CHANGELOG.md) | 릴리즈 노트 |

---

## 설정 파일

| 경로 | 내용 |
|---|---|
| `~/.pi/agent/modes.json` | 모드별 model / thinking / activeTools / systemPromptAddendum / temperature / chatTemplate, modelAliases, autoTitle(모델) + autoTitlePrompt, autoCompactThreshold + dynamicCompaction + compactModel + compactInstructions, modelAllowlist, **permissions** |
| `${cwd}/.pi/permissions.json` | 프로젝트 단위 권한 오버라이드 (전역 규칙을 덮어씀) |
| `${cwd}/.piignore` | gitignore 스타일 하드 차단 (모든 도구에 deny) |
| `${cwd}/AGENTS.md` | 프로젝트 컨텍스트 (시스템 프롬프트에 자동 주입) |
| `~/.pi/agent/AGENTS.md` | 전역 컨텍스트 |
| `~/.pi/agent/plans/` | `finalize_plan` 출력 |

> `~/.pi/agent/permissions.json` 은 레거시 전역 위치 — 존재하면 fallback으로 여전히 로드되지만, `modes.json` 안의 `permissions` 섹션을 권장합니다.

---

## 핵심 불변식

1. **`edit` / `write` 는 code 전용.** `plan` / `debug` / `ask` 의 `activeTools` 에서 자동 제거 (`state.ts:PROTECTED_FROM_NON_CODE`).
2. **`finalize_plan` 은 plan 전용.** code 모드로 가는 유일한 명시적 진입점.
3. **`request_mode_switch("code")` 는 차단됨.** code 모드는 오직 `finalize_plan` 으로만 도달.
4. **외부 경로는 여전히 권한 레이어를 거침.** `~/.ssh`, `/etc` 등은 `external_directory` 규칙에 따라 `ask` 또는 `deny`.

---

## 구조

```
<extension root>/
├── index.ts             진입점 — Runtime 구성, 도구/명령/단축키/훅 등록
├── config.ts            모드 스키마 + loadModes + DEFAULT_MODES (시스템 프롬프트)
├── constants.ts         STATUS_KEYS, AUTO_COMPACT_THRESHOLD, 버전/저자 단일 소스
├── runtime.ts           공유 Runtime 컨텍스트 (에디터 ref + 푸터 무효화)
├── ui.ts                ANSI / 배너 헬퍼, 혼합 케이스 "Hmm" 글리프 테이블
├── plans.ts             ~/.pi/agent/plans/ 경로 + 고유 이름 생성
├── config-io.ts         modes.json / keybindings.json / settings.json I/O
├── state.ts             ModeState (apply / reset / footer), RPC 클라이언트용 pushStatus
├── commands.ts          /mode, /mode-set, /plan-execute, /reset, /reload-runtime, /auto-approve, /thinking-toggle, /compact
├── shortcuts.ts         Tab, Ctrl+Alt+M, Alt+T, Alt+X, Ctrl+Shift+A
├── hooks.ts             session_start, before_agent_start (AGENTS.md), before_provider_request, agent_end, 압축
├── ask-user.ts          멀티 질문 카드 도구
├── request-mode-switch.ts   모드 전환 제안 (carry-over 지연)
├── finalize-plan.ts     플랜 커밋 + 3지선다 다이얼로그
├── todo.ts              OpenCode/Kilo 스타일 todo_write
├── auto-title.ts        첫 메시지 쌍 → GPT-mini → 세션 제목
└── permissions/         권한 시스템 — docs/PERMISSIONS.md 참고
    ├── index.ts         tool_call 훅 + 평가 진입점
    ├── defaults.ts      BASE_DEFAULTS + MODE_DEFAULTS
    ├── bash-rules.ts    BASH_DEFAULT + BASH_READ_ONLY (Kilo MIT 라이선스 패턴)
    ├── evaluator.ts     레이어 병합 + 최강 판정
    ├── glob.ts          경량 minimatch (path 모드 + shell 모드)
    ├── piignore.ts      .piignore 파서
    ├── extract-paths.ts 도구별 경로 추출
    ├── loader.ts        JSON 디스크 로더 (mtime 캐시)
    └── types.ts         Verdict / Permissions / Ruleset 스키마
```

경로는 수동 git-clone 설치의 경우 `~/.pi/agent/extensions/hmm-code-pi/`, 또는 `pi install` 이 놓은 위치(`pi list` 로 확인).

---

## 라이선스

MIT — [LICENSE](LICENSE) 참고.

## 감사의 말

- [Pi coding agent](https://github.com/badlogic/pi-mono) — 우리가 확장하는 에이전트 런타임
- [Kilo Code](https://github.com/Kilo-Org/kilocode) — 권한 규칙 패턴 + bash 허용목록 (MIT)
- [OpenCode](https://github.com/sst/opencode) — AGENTS.md 형식 + `todo_write` 스키마
