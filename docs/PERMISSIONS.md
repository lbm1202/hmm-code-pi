# Permission system

권한 시스템은 LLM 이 호출하는 모든 도구 (`read`/`edit`/`write`/`bash`/...)
를 평가해서 `allow` / `ask` / `deny` 중 하나로 판정한다. Kilo Code 의 모델
을 Pi 의 `tool_call` 훅에 이식한 것.

`modes.json` 의 `activeTools` 가 **모드별로 어떤 도구가 LLM 한테 보이는지**
를 제어한다면 (Layer 1), 권한 시스템은 **그 도구가 어떤 파일/명령을 만질
수 있는지** 를 제어한다 (Layer 2). 두 layer 는 직교.

---

## 1. 평가 계층 (낮은 → 높은 우선순위)

```
base defaults                    ← BASE_DEFAULTS (코드)
  └─ mode defaults               ← MODE_DEFAULTS[currentMode] (코드)
       └─ ~/.pi/agent/permissions.json     ← global user
            └─ ${cwd}/.pi/permissions.json ← project user
                 └─ ${cwd}/.piignore       ← 무조건 deny (별도 layer)
```

같은 layer 안에서는 **last-match wins** (Kilo 와 동일). 룰 객체의 키 순서대로
훑어서 마지막에 매칭된 verdict 가 그 layer 의 결과.

여러 layer 결과는 **strongest wins**: `deny > ask > allow`. 어느 한
layer 가 deny 하면 무조건 deny, ask 가 끼면 ask.

`.piignore` 에 매치되면 다른 layer 평가 없이 바로 deny.

---

## 2. 빌트인 디폴트

### Base (모든 모드)

```jsonc
{
  "rules": {
    "read": {
      "*": "allow",
      "*.env":         "ask",
      "*.env.*":       "ask",
      "*.env.example": "allow"
    },
    "edit":  { "*": "allow" },
    "write": { "*": "allow" },
    "bash":  BASH_DEFAULT    // ↓
  },
  "external_directory": {
    "*":            "ask",
    "/tmp/**":      "allow",
    "~/.pi/**":     "allow"
  }
}
```

### `BASH_DEFAULT` — code / debug 모드용

`*: ask` + 안전한 명령 30여 개만 `allow`. 즉 위에 없는 명령
(`rm`/`sudo`/`curl|sh`/`npm install`/`git push` 등) 은 모두 ask.

| 카테고리 | allow 패턴 |
|---|---|
| 파일 보기 | `cat *` `head *` `tail *` `less *` `ls *` `tree *` `pwd *` `echo *` |
| 검색/필터 | `grep *` `rg *` `ag *` `sort *` `uniq *` `cut *` `tr *` `jq *` `wc *` `which *` `type *` `file *` `diff *` |
| 시스템 정보 | `du *` `df *` `date *` `uname *` `whoami *` `printenv *` `man *` |
| 일상 mutator | `touch *` `mkdir *` `cp *` `mv *` `tsc *` `tsgo *` `tar *` `unzip *` `gzip *` `gunzip *` |

### `BASH_READ_ONLY` — plan / ask 모드용

`*: deny` + read-only 명령만 `allow` + **shell metachar 무조건 deny**.

| 카테고리 | 룰 |
|---|---|
| 기본 | `*: deny` |
| 위 BASH_DEFAULT 의 read-only allow 들 동일 |
| git read-only | `git *: deny` 후 `git log/show/diff/status/blame/rev-parse/ls-files/...` 만 allow |
| Shell metachar | `*\|*` `*;*` `*&&*` `*&*` `*$(*` `` *`* `` `*>*` `*>>*` `*<(*` 모두 deny |
| sort -o | `sort -o *` `sort * -o *` `sort --output*` deny (파일 쓰기라서) |

### 모드별 override

```ts
code:  {} // base 그대로
plan:  {
  rules: {
    bash:  BASH_READ_ONLY,
    edit:  { "*": "deny", ".pi/plans/*.md": "allow", ".pi/plans/**/*.md": "allow" },
    write: { "*": "deny", ".pi/plans/*.md": "allow", ".pi/plans/**/*.md": "allow" }
  }
}
debug: {} // base 그대로 (디버깅에 free shell 필요)
ask:   {
  rules: {
    bash:  BASH_READ_ONLY,
    edit:  { "*": "deny" },
    write: { "*": "deny" }
  }
}
```

> 참고: `activeTools` 가 plan/ask 에서 edit/write 를 LLM 한테 노출 안 함.
> 그래서 plan 의 `.pi/plans/*.md allow` 룰은 사용자가 activeTools 에 edit/
> write 를 직접 추가했을 때를 위한 defense in depth.

---

## 3. 사용자 설정 파일

### 글로벌: `~/.pi/agent/permissions.json`

첫 실행 시 `permissions.example.json` 이 자동 생성됨. 복사해서 `.example`
떼면 활성화.

### 프로젝트: `${cwd}/.pi/permissions.json`

프로젝트 디렉터리에 별도로 둠. 글로벌보다 우선.

### 스키마

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
    "plan":  { /* same shape — overrides for this mode only */ },
    "code":  { ... },
    "debug": { ... },
    "ask":   { ... }
  }
}
```

---

## 4. Glob 문법

**파일 path 용 (`read`/`edit`/`write`)**: gitignore-style
- `*` 한 디렉터리 안의 임의 문자 (슬래시 X)
- `**` 재귀 (슬래시 OK)
- `?` 한 글자 (슬래시 X)
- `[abc]` character class
- `~/` 홈 디렉터리 (`external_directory` 패턴에서)
- 슬래시 시작 (`/etc/...`) 또는 상대경로 (`src/...`)

**Bash 명령 용**: shell-mode (`*` 가 슬래시 가로지름)
- `*` 임의 문자 전부 (슬래시 포함)
- `**` 동일
- `"rm *"` → `rm /tmp/foo`, `rm -rf node_modules` 다 매치

---

## 5. `.piignore` (gitignore-style)

워크스페이스 루트의 `.piignore` 파일에 패턴 적으면 그 파일은 **모든 도구에서
접근 차단** (deny). 권한 layer 룰보다 우선.

```
# 코멘트
secrets/
*.key
*.pem
*.db
*.sqlite

# 부정 (allowlist override)
!secrets/public.json
```

- 디렉터리 패턴 (trailing `/`) 은 그 디렉터리 자체 + 내부 파일 다 매치
- `.gitignore` 와 별개 (서로 영향 X)
- 글로벌 ignore 없음 — 글로벌은 `~/.pi/agent/permissions.json` 의 deny 룰
  로 처리

---

## 6. Auto-approve (세션 토글)

`ask` 가 떠도 자동 통과시키는 binary 토글. 세션 한정 — `session_start`
마다 자동 OFF.

**조작 방법**:
- **CLI**: `/auto-approve` (토글) / `/auto-approve on` / `/auto-approve off`
- **VS Code**: 채팅 푸터의 "🔒 Auto" 버튼 (켜지면 🔓 + 주황색)

**의도적으로 영구화 없음** — 영구 ON 은 권한 시스템의 의의가 사라짐.
영구 룰이 필요하면 `~/.pi/agent/permissions.json` 에서 `"ask"` 를
`"allow"` 로 바꾸면 됨.

응답 도중 토글해도 즉시 적용 (다음 `tool_call` 부터). 슬래시 명령은
Pi 의 `agent-session.js:689` 에 따라 스트리밍 중에도 queue 없이 즉시
실행. 단 이미 떠 있는 confirm 다이얼로그는 사용자가 직접 처리해야 함.

---

## 7. 자주 쓰는 예시

### 시크릿 / 키 보호
```jsonc
{
  "rules": {
    "read": {
      "*.key": "deny",
      "*.pem": "deny",
      "id_rsa*": "deny",
      "*.sqlite": "ask"
    }
  }
}
```

### 회사 시스템 디렉터리 차단
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

### 특정 프로젝트만 외부 접근 허용
```jsonc
// ${cwd}/.pi/permissions.json
{
  "external_directory": {
    "~/Dev/shared-lib/**": "allow"
  }
}
```

### 위험 bash 명령 ask 강제
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

### debug 모드만 테스트 명령 자동 허용
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

### 모노레포의 일부 디렉터리만 edit 허용
```jsonc
// ${cwd}/.pi/permissions.json
{
  "rules": {
    "edit": {
      "*": "deny",
      "packages/my-pkg/**": "allow",
      "packages/my-pkg/dist/**": "deny"
    }
  }
}
```

---

## 8. 도구별 path 추출 규칙

권한 평가 시 어떤 path 가 룰에 매칭되는지:

| 도구 | path 출처 | 룰 키 |
|---|---|---|
| `read` | `input.path` | `read` |
| `edit` | `input.path` | `edit` |
| `write` | `input.path` | `write` |
| `multi_edit` | `input.path` + 각 `edits[].path` (전부 평가, 하나라도 deny 면 deny) | `edit` |
| `grep` | `input.path` (검색 root) | `read` |
| `find` | `input.path` | `read` |
| `ls` | `input.path` | `read` |
| `bash` | path 없음, `input.command` 매칭 | `bash` |

---

## 9. 외부 디렉터리 평가

워크스페이스 (`cwd`) 밖의 절대경로는 `external_directory` 룰과 일반
도구 룰을 둘 다 평가하고 **strongest** 적용. 즉 `external_directory:
"*": "ask"` 면 워크스페이스 밖 모든 read/edit/write 가 한 번 더 ask.

자동 화이트리스트:
- `/tmp/**` — Pi 가 임시 작업 자주 함
- `~/.pi/**` — Pi 자체 디렉터리

---

## 10. 헤드리스 환경

`!ctx.hasUI` (CI / 백그라운드 RPC) 에서 `ask` 가 나오면 **자동 deny**.
무한 대기 방지. 메시지: `"... (headless session — cannot prompt;
configure permissions.json to allow)"`.

CI 에서 자동화 돌리려면 해당 룰을 `"allow"` 로 미리 박아두거나, 그
세션에서만 `/auto-approve on` 보내야 함.

---

## 11. 트러블슈팅

### 룰을 추가했는데 적용 안 됨
1. JSON 문법 에러 — `~/.pi/agent/permissions.json` 파싱 실패 시 `[modes:permissions] failed to parse ...` 메시지가 stderr 에 뜸
2. Pi 가 reload 안 됨 — `/reload-runtime` 슬래시 (CLI) 또는 VS Code 의
   설정 패널 저장 (자동 reloadAll 트리거)
3. 마지막 매칭 룰을 봤는지 확인 — last-match-wins 라 catchall 을 위로,
   구체적인 룰을 아래로 두면 의도와 반대

### Bash 룰이 매칭 안 됨
- 슬래시 포함 명령은 path-mode glob 으로는 매칭 안 됨. evaluator 가
  bash 평가 시 shell-mode (`*` 가 슬래시 가로지름) 로 자동 전환.
- `"rm *"` 는 `rm /tmp/foo` 매치됨. 안 매치되면 룰 키 오타 가능성.

### Plan 모드에서 정상적인 명령이 deny
- `BASH_READ_ONLY` 는 shell metachar 가 들어가면 무조건 deny. `cat
  file | grep foo` 같은 거 막힘.
- 의도된 동작 (escape hatch 차단). 정말 필요하면 `code` 모드로 전환
  하거나 `${cwd}/.pi/permissions.json` 에 mode override 로 풀기.

### `.piignore` 가 무시되는 듯
- 워크스페이스 루트에만 둠 (서브디렉터리 미지원, 현재 버전).
- 패턴 끝의 `/` 는 디렉터리만 매치. 파일도 매치하고 싶으면 trailing
  `/` 빼기.
