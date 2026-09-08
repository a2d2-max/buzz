# 에이전트별 Claude/Codex 계정 실계정 검증 체크리스트

## 판정 범례와 안전 규칙

- **검증됨(워커)**: 코드 경로 또는 격리된 더미 자격 증명으로 자동 검증함.
- **실패(워커)**: 실행했으나 기대 조건을 만족하지 못함. 원인과 재시도 조건을 함께 적음.
- **Max 대기**: 실제 계정이나 앱 UI가 필요해 Max가 직접 해야 함. 워커 자동 테스트 통과만으로 완료 처리하지 않음.
- 비밀값, `auth.json` 내용, 키링 내용, 전체 프로세스 환경은 열거나 출력하지 않는다. `ps eww`도 사용하지 않는다.
- Orca의 `claude-accounts`, `codex-accounts` 디렉터리는 경로 확인도 포함해 접근하지 않는다.
- 로그에서는 아래에 적은 고정 시작·세션 행만 찾는다. 전체 로그를 화면에 출력하지 않는다.

앱 데이터 기준 경로는 정식 앱 기준 `~/Library/Application Support/xyz.block.buzz.app/agents`다. Dev 빌드는 앱 식별자가 `xyz.block.buzz.app.dev`이므로 `xyz.block.buzz.app.dev`로 바꾼다 (`desktop/src-tauri/tauri.conf.json:5`, `desktop/src-tauri/tauri.dev.conf.json:2`).

검증 전에 새 터미널에서 다음 비밀 없는 변수만 준비한다.

```bash
BUZZ_ACCOUNT_APP_DATA="$HOME/Library/Application Support/xyz.block.buzz.app/agents"
BUZZ_AGENT_PUBKEY='<앱에서 보이는 에이전트 전체 hex pubkey>'
BUZZ_VERIFY_AFTER="$(date '+%Y-%m-%d %H:%M:%S')"
```

## 워커가 끝낸 자동·격리 검증

| 상태 | 항목 | 실행·관찰 | 의미와 한계 |
|---|---|---|---|
| 검증됨(워커) | Codex API-key 실패 경로와 자격 증명 비노출 | 빈 임시 `CODEX_HOME`, 더미 키, 생산 코드와 같은 `codex exec --skip-git-repo-check ping` 실행. exit 1, 캡처 2,617 bytes, 더미 문자열·`sk-` 형태 모두 캡처에서 미검출 | 실제 OpenAI 인증 성공 증거가 아니다. command-equivalent CLI의 깨끗한 실패 증거다. 생산 Test 백엔드의 nonzero/스크러버 결합 검증은 Rust 테스트 결과로 별도 판정한다. |
| 검증됨(워커) | Codex ChatGPT 미로그인 상태 | 빈 임시 `CODEX_HOME`, ambient `OPENAI_API_KEY` 제거 후 `codex login status`. exit 1, 14 bytes, `auth.json` 없음, `sk-` 형태 없음 | `auth.json` gate는 production source inspection으로 확인했다. AppHandle/store를 포함한 실제 스폰 거부는 자동 테스트가 직접 호출하지 않았으므로 Max UI에서 판정한다. |
| 검증됨(워커) | Claude OAuth 더미 실패 경로 | 빈 임시 `CLAUDE_CONFIG_DIR`, ambient `ANTHROPIC_API_KEY` 제거, 더미 `CLAUDE_CODE_OAUTH_TOKEN`, 생산 코드와 같은 `claude -p ping --model claude-haiku-4-5-20251001`. exit 1, 60 bytes, 더미 문자열·`sk-ant-` 형태 미검출 | 실제 Anthropic 인증 성공 증거가 아니다. command-equivalent CLI의 깨끗한 실패 증거다. 생산 Test 백엔드 결합은 Rust 테스트 결과로 별도 판정한다. |
| 검증됨(워커) | Rust 계정 저장·home policy·스폰 env·스크러버 | auth env를 unset한 격리 shell에서 `. ./bin/activate-hermit; CARGO_TERM_COLOR=never cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml 'accounts::tests'`: parser fix 뒤 재실행 exit 0, 62 passed, 0 failed/ignored, 3,194 filtered out, runner 0.13s, wall 2.91s. `CARGO_TERM_COLOR=never cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml 'requires_restart_and_never_snapshots'`: 2 passed, 0 failed/ignored, 3,242 filtered, runner 0.01s | 테스트 double 증거다. 실제 provider 로그인이나 child session handoff 증거는 아니다. 테스트용 빈 sidecar placeholder를 썼다. |
| 검증됨(워커) | production Test 백엔드의 nonzero·스크러버 결합 | Test command가 실제 사용하는 bounded 실행/결과 축약 helper에 exit 7 더미 subprocess를 넣어 `ok=false`, exact dummy와 provider-shaped secret 제거를 확인 | AppHandle/store lookup과 전체 CLI args/env 조립을 직접 호출한 증거는 아니다. command assembly 뒤 실제 production 실행·exit 판정·stderr 선택·스크러버 결합만 검증한다. |
| 검증됨(워커) | malformed account config 오류 비노출 | 같은 잘못된 TOML 행에 exact dummy와 provider-shaped `sk-` marker를 둔 뒤 공용 home policy production helper를 호출. 반환 오류에 exact/shape 모두 없고 원본 config bytes가 같음을 회귀 테스트로 확인 | 실제 비밀이나 기존 account config는 읽지 않았다. 파서의 원문 포함 Display는 IPC 오류에 사용하지 않는다. |
| 검증됨(워커) | desktop 전체 `node:test` | `cd desktop && pnpm test`: 86 suites, 6,736 passed, 0 failed/cancelled/skipped/todo, runner 187,071ms | 선택기와 저장 payload 계약을 검증한다. 실제 Tauri command나 CLI를 실행하지 않는다. |
| 실패(워커) | Tauri no-default-features broad run | 마지막 parser-error redaction 수정 직전 frozen source에서 `. ./bin/activate-hermit && cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml --workspace --no-default-features --no-fail-fast -- --test-threads=4`: exit 101, 전체 target 합산 3,331 passed, 1 failed, 12 ignored. desktop lib는 3,230 passed, 1 failed, 11 ignored, 91.99s이고 이후 target도 끝까지 실행되어 추가 실패 없음 | 유일한 실패 `bounded_command::tests::fails_closed_when_capture_exceeds_limit`는 단독 재현됐다. 조사 시 fixture의 `/dev/zero`가 약 7초에 770,048 bytes만 써 1MiB cap에 닿지 못했고 helper는 정상 50ms poll 상태였다. host-sensitive fixture 한계이며 production hang/unbounded 증거는 아니다. 마지막 수정은 post-fix account slice로 따로 재검증한다. |

## 1. Codex API key 계정

### 1-A. 추가와 Test

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** `Settings` → `Agents` → `Codex accounts` → `Add account` → `API key`. 계정 이름과 실제 키를 입력하고 `Add account`, 생성된 행의 `Test`를 누른다.
- **무엇이 보여야 하나:** 행에 `API key`가 표시되고, Test 뒤 `Works — ...`가 표시된다. `Failed — ...`면 중단하고 메시지 한 줄만 기록한다. 키 자체는 기록하지 않는다 (`AddCodexAccountDialog.tsx:159-275`, `CodexAccountRow.tsx:219-244`).
- **어떻게 증명하나:** 결과 화면에서 계정 라벨, `API key`, `Works`만 캡처한다. 키 입력란이나 키링은 캡처하지 않는다. Test 백엔드는 같은 계정 홈과 키로 `codex exec --skip-git-repo-check ping`을 실행한다 (`desktop/src-tauri/src/commands/codex_accounts.rs:196-274`).

### 1-B. 에이전트에 붙이고 재시작

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** `Agents`에서 Codex 에이전트 `Manage` → `Edit` → `Codex account`에서 방금 만든 라벨 선택 → `Save`.
- **무엇이 보여야 하나:** 실행 중인 에이전트에는 `Restart required` 배지와 `codex_account_id` 변경 diff가 보인다. `Restart`를 누른 뒤 새 목록 조회에서 배지가 사라져야 한다 (`EditAgentCodexAccountField.tsx:74-95`, `RestartDiffBadge.tsx:144-188`).
- **어떻게 증명하나:** 저장 직후 배지 캡처, 재시작 뒤 배지 없는 화면 캡처. 재시작 직전에 `BUZZ_VERIFY_AFTER`를 다시 설정한 뒤 다음 안전 명령을 실행한다.

```bash
find "$BUZZ_ACCOUNT_APP_DATA/logs" -type f -name "${BUZZ_AGENT_PUBKEY}__*.log" \
  -newermt "$BUZZ_VERIFY_AFTER" -print0 | while IFS= read -r -d '' BUZZ_RECENT_LOG; do
    stat -f '%N | %z bytes | %Sm' -t '%Y-%m-%d %H:%M:%S' "$BUZZ_RECENT_LOG"
    rg -n -m 4 '=== starting .* at |session created:' "$BUZZ_RECENT_LOG"
  done
```

`Test`와 스폰은 같은 `CODEX_HOME`/키 적용 규칙을 사용한다. 스폰은 사용자 env 뒤에 선택 계정을 적용해 수동 `OPENAI_API_KEY`·`CODEX_HOME`보다 선택 계정이 이긴다 (`desktop/src-tauri/src/managed_agents/runtime.rs:780-794`, `desktop/src-tauri/src/managed_agents/codex_accounts.rs:405-426`).

### 1-C. 앱 생성 CODEX_HOME과 세션 파일

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 별도 클릭 없음. 계정 행 메뉴에 API key 계정은 `Copy login command`가 없으므로 앱 데이터 아래 `codex-homes`에서 최근 변경된 UUID 디렉터리를 경로·시각으로만 찾는다.
- **무엇이 보여야 하나:** `<app-data>/agents/codex-homes/<account-id>/`가 존재하고, 재시작 후 그 아래 `sessions/.../*.jsonl`이 새로 생긴다. API-key 계정 홈에는 `auth.json`이 없어야 한다.
- **어떻게 증명하나:** 내용은 읽지 않고 경로·크기·mtime만 확인한다.

```bash
find "$BUZZ_ACCOUNT_APP_DATA/codex-homes" -mindepth 1 -maxdepth 1 -type d \
  -newermt "$BUZZ_VERIFY_AFTER" -exec stat -f '%N | %Sm' -t '%Y-%m-%d %H:%M:%S' {} \;
BUZZ_CODEX_ACCOUNT_HOME='<위에서 확인한 정확한 계정 디렉터리>'
test ! -e "$BUZZ_CODEX_ACCOUNT_HOME/auth.json" && echo 'PASS auth.json absent'
find "$BUZZ_CODEX_ACCOUNT_HOME/sessions" -type f -name '*.jsonl' \
  -newermt "$BUZZ_VERIFY_AFTER" -exec stat -f '%N | %z bytes | %Sm' -t '%Y-%m-%d %H:%M:%S' {} \;
```

새 세션 파일, 같은 시각대의 agent log `session created:`, Test 성공이 함께 있어야 통과다. 세션 JSONL 내용은 열지 않는다. `sessions/<연도>/<월>/<일>/*.jsonl` 배치는 현재 설치된 `codex-cli 0.153.4`에서 관찰한 버전별 보조 증거이며 안정된 공개 계약으로 간주하지 않는다.

## 2. Codex ChatGPT 계정

### 2-A. 계정 생성과 로그인 명령 복사

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** `Settings` → `Agents` → `Codex accounts` → `Add account` → `ChatGPT login` → 이름 입력 → `Add account`.
- **무엇이 보여야 하나:** `Log the account in` 화면과 `CODEX_HOME=".../agents/codex-homes/<id>" codex login` 명령, `Copy command`와 `Done` 버튼이 보인다 (`AddCodexAccountDialog.tsx:123-152`). 앱은 이 명령을 내주기 전에 같은 홈의 `config.toml`을 `cli_auth_credentials_store = "file"`로 수렴시켜 OAuth 결과가 spawn gate가 확인하는 `auth.json`에 저장되도록 해야 한다.
- **어떻게 증명하나:** `Copy command`를 눌러 명령을 별도 안전한 메모리에 보관한다. 아직 실행하지 않는다. 2-B의 미로그인 거부를 먼저 확인해야 한다.

### 2-B. 미로그인 스폰 거부

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** OAuth 전에 `BUZZ_VERIFY_AFTER="$(date '+%Y-%m-%d %H:%M:%S')"`를 다시 설정한다. 이 계정을 Codex 에이전트에 저장하고 `Start` 또는 `Restart`.
- **무엇이 보여야 하나:** 시작이 실패하고 `Codex account "<label>" is not logged in yet`와 한 번 실행할 로그인 명령이 보인다. 새 시작 로그 marker가 생기면 실패다. production lookup은 `auth.json`이 없으면 side effect 전에 거부한다 (`desktop/src-tauri/src/managed_agents/codex_accounts.rs:354-391`, `desktop/src-tauri/src/managed_agents/runtime.rs:520-532`).
- **어떻게 증명하나:** 오류 문구만 캡처하고 다음 명령으로 거부 시각 이후 새 로그가 없는지 확인한다.

```bash
find "$BUZZ_ACCOUNT_APP_DATA/logs" -type f -name "${BUZZ_AGENT_PUBKEY}__*.log" \
  -newermt "$BUZZ_VERIFY_AFTER" -exec stat -f '%N | %z bytes | %Sm' -t '%Y-%m-%d %H:%M:%S' {} \;
```

### 2-C. 실제 로그인·Test·연결·재시작·세션 증명

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 2-A에서 복사한 명령을 새 터미널에 그대로 붙여 실행하고 Max가 브라우저 OAuth를 완료한다. 계정 행 `Test` → 에이전트의 `Codex account`에서 그 라벨 선택·Save → `Restart`.
- **무엇이 보여야 하나:** Test `Works`; 저장 뒤 `Restart required`; 재시작 뒤 배지 해제와 정상 세션 시작.
- **어떻게 증명하나:** `BUZZ_CODEX_ACCOUNT_HOME`을 로그인 명령에 표시된 경로로 놓고, 1-B 로그 명령과 1-C 세션 파일 명령을 반복한다. `auth.json`은 존재 여부만 확인하고 내용·크기·hash를 출력하지 않는다.

OpenAI 공식 문서는 `codex login`이 브라우저 흐름을 시작하고 `codex login status`가 현재 인증 방법을 확인한다고 설명한다. `cli_auth_credentials_store="file"`일 때 자격 증명이 `CODEX_HOME/auth.json`에 저장되고, `keyring`은 OS credential store, `auto`는 가능한 경우 OS store를 쓴다. 이 앱의 lookup은 `auth.json` 존재를 요구하므로 공용 account-home 준비 경로가 `file`을 원자적·멱등적으로 강제한다: [OpenAI Codex authentication](https://developers.openai.com/codex/auth/), [OpenAI Codex config reference](https://developers.openai.com/codex/config-reference/).

```bash
test -e "$BUZZ_CODEX_ACCOUNT_HOME/auth.json" && echo 'PASS auth.json present'
rg -n -m 1 '^cli_auth_credentials_store = "file"$' "$BUZZ_CODEX_ACCOUNT_HOME/config.toml"
find "$BUZZ_CODEX_ACCOUNT_HOME/sessions" -type f -name '*.jsonl' \
  -newermt "$BUZZ_VERIFY_AFTER" -exec stat -f '%N | %z bytes | %Sm' -t '%Y-%m-%d %H:%M:%S' {} \;
```

## 3. Claude 계정

### 3-A. 추가와 Test

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 터미널에서 `claude setup-token`을 사람이 실행해 토큰을 얻는다. `Settings` → `Agents` → `Claude accounts` → `Add account`, 이름과 토큰 입력 → `Add account` → 생성 행 `Test`.
- **무엇이 보여야 하나:** `Works — ...`. Test 백엔드는 ambient `ANTHROPIC_API_KEY`를 제거하고 선택 토큰으로 `claude -p ping --model claude-haiku-4-5-20251001`을 실행한다 (`desktop/src-tauri/src/commands/claude_accounts.rs:151-210`).
- **어떻게 증명하나:** 계정 라벨과 `Works`만 캡처한다. 토큰 입력·출력·힌트는 기록하지 않는다.

### 3-B. 연결·재시작

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** `Agents` → 대상 Claude 에이전트 `Manage` → `Edit` → `Claude account`에서 라벨 선택 → `Save` → `Restart`.
- **무엇이 보여야 하나:** 저장 뒤 `Restart required`, 재시작 뒤 배지 해제, 정상 `session created:` 로그.
- **어떻게 증명하나:** 1-B의 로그 명령과 두 화면 캡처를 사용한다. 자동 검증은 계정 ID가 spawn snapshot에 남고, 키링 토큰이 user env 뒤 `CLAUDE_CODE_OAUTH_TOKEN`에 적용되며 ambient `ANTHROPIC_API_KEY`는 제거되는 것을 확인한다 (`desktop/src-tauri/src/managed_agents/claude_accounts.rs:415-471`, `desktop/src-tauri/src/managed_agents/runtime.rs:507-518`, `desktop/src-tauri/src/managed_agents/runtime.rs:780-791`).

현재 저장 계정 방식은 `CLAUDE_CONFIG_DIR`별 OAuth 저장이 아니라 OS 키링의 setup-token을 `CLAUDE_CODE_OAUTH_TOKEN`으로 넣는 방식이다 (`desktop/src-tauri/src/managed_agents/claude_accounts.rs:1-19`). 따라서 Codex처럼 계정별 세션 디렉터리만으로 토큰 계정 신원을 독립 증명할 수 없다. 보조 확인은 Max가 이번 검증용으로 직접 만든 Buzz app-data 아래 전용 디렉터리를 agent env의 `CLAUDE_CONFIG_DIR`로 설정한 경우에만 한다. 기존 경로나 Orca `claude-accounts`/`codex-accounts` 경로일 가능성이 조금이라도 있으면 경로 존재 확인도 하지 않고 이 단계를 생략한다.

```bash
BUZZ_CLAUDE_CONFIG_DIR="$BUZZ_ACCOUNT_APP_DATA/verify-claude-config"
find "$BUZZ_CLAUDE_CONFIG_DIR/projects" -type f \
  -newermt "$BUZZ_VERIFY_AFTER" -exec stat -f '%N | %z bytes | %Sm' -t '%Y-%m-%d %H:%M:%S' {} \;
```

이 경로 증거는 config-dir 적용과 세션 생성을 증명할 뿐, 어느 OAuth 토큰이 쓰였는지는 Test 성공+자동 env 주입 증거로 판정한다.

## 4. 계정 전환, 재시작 배지, 실제 handoff

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 이미 계정 A로 실행 중인 에이전트에서 Edit → 같은 provider의 계정 B 선택 → Save. `Restart required` 확인 → `Restart`.
- **무엇이 보여야 하나:** 재시작 전 diff에 `codex_account_id` 또는 `claude_account_id` 변경이 보이고, 재시작이 성공한 뒤 배지가 사라진다. 배지는 설정 저장만으로 사라지면 실패다.
- **어떻게 증명하나:** Codex는 A/B 각각의 `CODEX_HOME/sessions`를 경로·mtime만 비교한다. 재시작 뒤에는 B에만 새 세션 파일이 생겨야 한다. Claude는 A/B 각각 Test 성공, ID snapshot diff, 재시작 뒤 새 session log를 묶어 판정한다. 현재 black-box 로그만으로 Claude token 계정명을 식별하는 별도 표시는 없다.

스폰이 await 중일 때 계정 설정이 바뀌어도 최종 store lock 뒤 record를 다시 읽어 최신 ID로 스폰한다 (`desktop/src-tauri/src/commands/agents.rs:163-233`). 실제 handoff 뒤 child에 찍힌 spawn snapshot과 현재 record가 같을 때만 배지가 해제된다 (`desktop/src-tauri/src/managed_agents/runtime.rs:231-266`, `desktop/src-tauri/src/managed_agents/runtime.rs:835-905`).

### 4-B. 진행 중인 Test·Start와 계정 변경 경합

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 계정 A의 `Test`를 누른 직후, 대상 agent의 Edit에서 계정 B를 선택해 `Save`한다. 이어 agent를 Stop한 상태에서 `Start`를 누르고 readiness가 진행 중일 때 다시 Edit에서 B를 선택·저장하는 순서를 한 번 반복한다. 실제 비밀을 바꾸지 않고 이미 Test를 통과한 A/B만 사용한다.
- **무엇이 보여야 하나:** 늦게 끝난 A의 Test 결과가 agent picker를 A로 되돌리면 실패다. 진행 중 Start가 과거 A를 잡아도 실패다. 최종 선택은 B, 실행 중 변경 뒤에는 `Restart required`, 실제 B handoff가 끝난 뒤에만 badge 해제여야 한다.
- **어떻게 증명하나:** Codex는 `BUZZ_VERIFY_AFTER`를 각 Start/Restart 직전에 다시 놓고 A/B home의 새 session 경로·mtime만 비교한다. B에만 새 session이 생겨야 한다. Claude는 B의 Test 성공, 최종 picker B, 새 agent log marker와 restart badge 순서를 캡처한다. 자동 코드 증거는 preflight await 뒤 durable record를 다시 읽어 최신 account ID를 해석하고, spawn snapshot이 handoff된 ID를 보관하는 경로다. live 결과를 자동 테스트로 대체하지 않는다.

## 5. 계정 삭제 뒤 기본 로그인 복귀

- **상태:** Max 대기
- **누가:** Max
- **사전 조건:** 저장 계정을 붙이기 전에 같은 에이전트를 `Default (app login)`으로 한 번 시작해 정상 `session created:` 로그를 남긴다. 이 기본 로그인 baseline이 실패하면 삭제 복귀 검증을 시작하지 않는다.
- **무엇을 누르나:** 계정 A를 쓰는 에이전트가 실행 중인 상태에서 `Settings` → `Agents` → provider 계정 행 `…` → `Remove` → 확인 `Remove`.
- **무엇이 보여야 하나:** 경고에 `Agents using this account switch back to the app's own ... login and will need a restart.`가 보인다. 삭제 완료 toast는 `switched to the default login — restart them to apply.`를 표시한다. 실행 중 agent에는 `Restart required`가 떠야 한다 (`CodexAccountRow.tsx:315-359`, `ClaudeAccountRow.tsx:289-330`). Edit를 다시 열면 account picker가 `Default (app login)`이어야 한다.
- **어떻게 증명하나:** 삭제 직후에는 기존 child가 즉시 바뀌지 않는다. Edit의 `Default (app login)` 선택 상태를 캡처하고, `BUZZ_VERIFY_AFTER`를 다시 설정한 뒤 반드시 `Restart`한다. 배지가 사라지고 새 `session created:` 로그가 생기며 사전 조건의 known-working default 동작이 재현돼야 통과다. Codex ChatGPT 계정의 옛 홈은 삭제되며, 새 세션 파일이 그 옛 홈에 생기면 실패다.

```bash
test ! -e "$BUZZ_CODEX_ACCOUNT_HOME" && echo 'PASS removed account home absent'
```

삭제 command는 agent record의 account ID를 먼저 clear·저장한 뒤 계정과 Codex 홈을 지운다 (`desktop/src-tauri/src/commands/codex_accounts.rs:121-171`, `desktop/src-tauri/src/commands/claude_accounts.rs:97-148`). 에이전트·Persona·Global env에 `OPENAI_API_KEY`, `CODEX_HOME`, `CLAUDE_CODE_OAUTH_TOKEN`이 남아 있으면 UI는 `Custom (env var)`를 사용하므로 `Default (app login)` 복귀가 아니다. 먼저 해당 env를 제거하고 다시 저장·재시작한다 (`codexAccountOptions.ts:1-53`, `claudeAccountOptions.ts:5-61`).

## 6. 상속 env 충돌 확인

- **상태:** Max 대기
- **누가:** Max
- **무엇을 누르나:** 테스트용 agent env에 의도적인 비밀 아닌 placeholder `OPENAI_API_KEY=dummy-manual`, `CODEX_HOME=/tmp/dummy-manual-home` 또는 `ANTHROPIC_API_KEY=dummy-manual`, `CLAUDE_CODE_OAUTH_TOKEN=dummy-manual`을 저장한다. 그 뒤 저장 계정 라벨을 선택하고 재시작한다.
- **무엇이 보여야 하나:** picker 도움말이 선택 계정이 env 값을 override한다고 알린다. 실계정 agent는 정상 시작한다.
- **어떻게 증명하나:** Codex는 선택 계정 홈에만 새 session 파일이 생겨야 한다. Claude는 정상 session log와 선택 계정 Test 성공을 확인한다. 전체 child env는 절대 출력하지 않는다. 자동 테스트가 Command의 최종 env에서 선택 계정 값이 placeholder를 덮고 경쟁 API key를 remove하는 것을 검증한다.

## 7. Hermes 기준에서 빠진 요구사항과 인계

현재 구현에는 다음이 없다. 이 작업에서 UI를 추가하지 않고 `/Users/sign-x/.buzz/PLANS/ACCOUNT_USAGE_UI_BRIEF.md`가 이어받는다. 해당 브리프는 `AGENT_USAGE_BRIEF.md` 통합 뒤 시작하라고 명시한다 (`ACCOUNT_USAGE_UI_BRIEF.md:8-18`).

- **계정별 상시 상태 없음:** account row는 사용자가 `Test`를 눌렀을 때만 mutation 결과를 row local state로 렌더링한다. 저장되는 `ProviderAccount`에는 `id`, `label`, `created_at`, `token_hint`, `provider`, `auth_kind`만 있고 상태·마지막 확인 시각이 없다 (`claude_accounts.rs:64-87`, `CodexAccountRow.tsx:49-54`, `CodexAccountRow.tsx:295-312`, `ClaudeAccountRow.tsx:266-287`).
- **앱 시작·주기 자동 검사 없음:** `useTestCodexAccountMutation`과 `useTestClaudeAccountMutation`은 버튼 호출 mutation뿐이며 timer/query가 없다 (`useCodexAccounts.ts:91-100`, `useClaudeAccounts.ts:89-93`). 인계 브리프는 앱 시작과 N분마다 `codex login status`, `claude auth status`류의 조용한 상태 확인을 요구한다.
- **상태 배지 없음:** Settings 행, agent list/detail, edit dropdown 어디에도 `사용 가능 / 로그인 필요 / 실패 / 마지막 확인 시각`을 표현하는 account 상태 필드가 없다. `Works/Failed`는 현재 행에서 수동 Test 직후에만 보인다.
- **남은 한도·최근 사용량 없음:** account 타입과 row는 account ID별 오늘/7일 토큰, 추정 비용, 마지막 사용 시각, 출처를 받거나 렌더링하지 않는다. 인계 브리프는 agent-usage SQLite 집계가 들어온 뒤 NIP-AM과 로그 스캔 출처를 구분하고 합산하지 말라고 요구한다 (`ACCOUNT_USAGE_UI_BRIEF.md:11-15`).
- **붙일 위치:** Rust는 account 상태 probe scheduler/result DTO와 account-id별 usage reader를 기존 `commands/{claude,codex}_accounts.rs` 및 account store 옆에 둔다. React Query는 `use{Claude,Codex}Accounts.ts`; Settings 표시는 `{Claude,Codex}AccountRow.tsx`; agent 목록/상세는 `ManagedAgentRow.tsx`와 config/profile surface; dropdown은 `EditAgent{Claude,Codex}AccountField.tsx`에서 같은 DTO를 소비한다. 상태 source와 usage source는 분리한다.

## 최종 판정표

| 항목 | 자동 증거 | Max 실기 | 최종 |
|---|---|---|---|
| Codex API key Test 실패가 깨끗함 | command-equivalent와 production execution/reduction 회귀 통과 | 불필요 | 검증됨(워커) |
| Codex API key 실계정 Test→스폰→세션 파일 | env/snapshot 자동 테스트 통과 | 필수 | Max 대기 |
| Codex ChatGPT 미로그인 스폰 거부 | generic dangling-account fail-closed 테스트와 production `auth.json` gate source inspection만 완료 | 필수 | Max 대기 |
| Codex ChatGPT 로그인→Test→스폰→세션 파일 | 공용 home policy와 env/snapshot 회귀 통과 | OAuth 필수 | Max 대기 |
| Claude Test→스폰 | env/snapshot과 production reduction 회귀 통과 | 필수 | Max 대기 |
| 계정 A→B 전환과 배지 handoff | snapshot diff 표적 2개 통과 | 필수 | Max 대기 |
| 삭제→기본 로그인 | detach/snapshot 기존 테스트 통과 | 필수 | Max 대기 |
| 상속 env 충돌에서 명시 선택 우선 | Command env 기존 테스트 통과 | 필수 | Max 대기 |

## 잔여 한계

- 계정 metadata atomic write와 그 직후 keyring rollback delete가 동시에 실패하면 두 오류는 모두 호출자에게 반환되지만, 이미 임의 UUID 이름으로 생긴 orphan keyring entry를 자동 재시도하는 journal은 없다. 기존 cross-store 한계이며 이번 검증이 완전한 durable cleanup을 증명하지 않는다.
- Tauri broad run의 overflow fixture는 이 host에서 10초 안에 1MiB를 쓰지 못해 실패했다. production helper hang 증거는 아니지만 해당 큰-output regression 한 건은 통과하지 않았다. 따라서 전체 suite 성공이나 full CI 통과를 주장하지 않는다.
- 실제 OAuth, 유료 provider 인증, child identity와 세션 provenance는 Max 실기를 완료하기 전까지 검증 완료로 표시하지 않는다.
