# 계정 실주입 검증 진행 상황

## 현재 상태

- 브랜치: `a2d2-max/account-verify`
- 시작 HEAD: `b2978786cf2cbdf7b2876b16371ddc324d88a1b4`
- 현재 단계: 7. 최종 검토와 로컬 signed commit
- 상태: 워커 실행 완료, Max 실계정 검증 대기

## 단계

- [x] 1. 저장소 지침, 제품 비전, 테스트 지침, 관련 코드 확인
- [x] 2. 계정 추가·테스트·할당·재시작·삭제·변경 경로와 증거 지점 추적
- [x] 3. Rust 테스트와 Node 테스트 실행 완료 (Node green, Tauri broad 1 known fixture failure)
- [x] 4. 더미 키 프로브 실패 경로와 비밀 스크러버 검증 (command-equivalent + production execution/reduction 회귀 통과)
- [x] 5. 발견한 계정 기능 버그 수정 및 회귀 검증 (auth store/home ownership 수정, 독립 review·표적 테스트 통과)
- [x] 6. `ACCOUNT_VERIFY_CHECKLIST.md` 작성 (자동 증거·known failure·Max 실기 분리)
- [x] 7. 최종 독립 검토 및 로컬 signed commit (결과 hash는 최종 보고에 기록)

## 테스트 기록

- Codex API-key command-equivalent 더미 probe: exit 1, 캡처 2,617 bytes, 더미 문자열/`sk-` 형태 미검출. 실제 provider 인증 성공 증거 아님
- Codex ChatGPT 빈 홈 `codex login status`: exit 1, 캡처 14 bytes, `auth.json` 없음, `sk-` 형태 미검출
- Claude OAuth command-equivalent 더미 probe: exit 1, 캡처 60 bytes, 더미 문자열/`sk-ant-` 형태 미검출. 실제 provider 인증 성공 증거 아님
- Tauri 기본 feature 계정 표적: 50 passed, 0 failed, 0 ignored, 3,194 filtered out. 테스트용 sidecar placeholder 사용, live spawn 증거 아님
- Tauri restart snapshot: `CARGO_TERM_COLOR=never cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml 'requires_restart_and_never_snapshots'`, 2 passed, 0 failed/ignored, 3,242 filtered out, runner 0.01s, compile 포함 wall 약 32s
- Tauri 기본 feature 계정 표적 parser-fix 뒤 최종 재실행: auth env unset 후 `. ./bin/activate-hermit; CARGO_TERM_COLOR=never cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml 'accounts::tests'`, exit 0, 62 passed, 0 failed/ignored, 3,194 filtered out, runner 0.13s, wall 2.91s
- Desktop 전체 `pnpm test`: 86 suites, 6,736 passed, 0 failed/cancelled/skipped/todo, runner 187,071ms (의존성 relink 포함 wall 약 194초)
- Tauri no-default-features broad (마지막 parser-error redaction 수정 직전 frozen source): `. ./bin/activate-hermit && cargo test --quiet --manifest-path desktop/src-tauri/Cargo.toml --workspace --no-default-features --no-fail-fast -- --test-threads=4`, exit 101. 전체 target 합산 3,331 passed, 1 failed, 12 ignored. desktop lib 3,230 passed, 1 failed, 11 ignored, 91.99s; 이후 target 모두 완료, 추가 실패 없음
- 유일 실패 `bounded_command::tests::fails_closed_when_capture_exceeds_limit`는 단독 재현. fixture가 약 7초에 770,048 bytes만 써 10초 watchdog 전에 1MiB cap에 못 닿았고 helper는 정상 50ms poll 상태였음. host-sensitive fixture 한계이며 production hang/unbounded 증거 아님

## 조사 메모

- `desktop/AGENTS.md`는 이 체크아웃에 없음. 적용되는 하위 지침은 `desktop/src/features/agents/AGENTS.md`
- c57e4f60b은 Codex 계정 저장소, 명령, 스폰 인증 해석, readiness, 재시작 스냅샷, UI 선택기와 테스트를 추가함
- 스폰 전 account ID를 다시 읽고 store lock 아래 auth를 해석하므로 preflight 중 계정 전환은 최신 record를 사용함
- 계정 삭제는 연결 agent ID를 먼저 durable clear하고, running child는 재시작 뒤에만 기본 로그인으로 전환됨
- OpenAI 공식 계약에서 `file`만 account `CODEX_HOME/auth.json`에 저장하고 `keyring`/`auto`는 OS store를 쓸 수 있음. 기존 spawn gate는 `auth.json` 존재를 요구하면서 account home의 store를 강제하지 않아 로그인 성공 뒤 스폰 거부 가능
- 공용 account-home 준비 경로에 `cli_auth_credentials_store="file"` 원자·멱등 수렴을 추가함. 다른 TOML 값·주석은 보존하고 malformed/unwritable config는 덮어쓰지 않고 오류로 닫음
- malformed TOML parser Display가 원문 행을 포함하므로 IPC 오류에서는 parser 문자열을 버림. exact dummy/provider-shaped marker 비노출과 원본 byte 보존 회귀를 추가함
- 공용 준비 경로는 add, login command, Test, spawn lookup에서 재사용되며 restart/resume도 같은 spawn lookup을 거침
- 독립 source review는 UUID/path fence, final-dir atomic reserve, home/config symlink fail-closed, TOML 보존+원자 저장, nonrecursive partial cleanup, home-before-store 순서에 blocking finding 없음으로 판정
- 잔여 한계: metadata write와 keyring rollback delete가 동시에 실패하면 두 오류는 전파되지만 random-ID orphan keyring entry의 자동 retry journal은 없음

## max가 해야 할 단계

- Codex API key 실제 계정: Add → Test → agent 선택 → Restart → app log와 account `CODEX_HOME/sessions` 경로 증명
- Codex ChatGPT: OAuth 전 선택·Start/Restart 거부 → 앱이 복사한 `CODEX_HOME=... codex login`으로 OAuth → Test → 선택·Restart → 같은 home의 session 경로 증명
- Claude 실제 계정: setup-token Add → Test → 선택·Restart → agent log 증명. 전용 Buzz app-data `CLAUDE_CONFIG_DIR`를 직접 만든 경우에만 projects 보조 확인
- 계정 A→B 변경, 진행 중 Test/Start 경합, 실제 handoff 뒤 restart badge 해제, 삭제 뒤 `Default (app login)` picker와 known-working default restart 확인
- inherited env placeholder 충돌에서 저장 계정 선택이 이기는지 확인하고, 증거는 전체 env 출력 없이 log/session 경로·mtime만 기록

## 제약과 승인 경계

- 비밀값, 토큰, 키, `auth.json` 내용은 읽거나 출력하거나 기록하지 않음
- Orca 계정 디렉터리는 읽지 않음
- 머지, 푸시, 배포, Buzz 게시는 하지 않음
- 사람의 브라우저 OAuth 단계는 `max가 할 것`으로 남김
