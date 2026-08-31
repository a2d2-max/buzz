# Fork Baseline

- Upstream repository: https://github.com/block/buzz
- Upstream SHA: b49675894b39f87215e4dfc8c1ad4a3c28c6097e
- Product branch: feat/native-ops-wrapper
- Ops bridge contract: 1
- Hub root: /Users/sign-x/Documents/Codex/2026-08-26/orchestration-dashboard/.worktrees/feat-buzz-agent-room
- Relay schema changes for Ops v1: none
- Computer History source: user-selected files only
- Voice model at design time: gpt-realtime-2.1
- Verified on: 2026-08-28 Asia/Seoul

## Pinned development toolchain

- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`
- Node.js: `v24.15.0`
- pnpm: `11.4.0`
- just: `1.46.0`
- Flutter: `3.41.7` stable
- Dart: `3.11.5` stable (`macos_arm64`)
- Docker: client/server `29.2.0`
- Git: `2.49.0`

## Installation and services

- `. ./bin/activate-hermit && just bootstrap`: PASS. `.env` was created from `.env.example` with a generated relay private key.
- `git check-ignore .env`: PASS; output was `.env`.
- `. ./bin/activate-hermit && just setup`: PASS after the host-environment conflicts below were resolved. Buzz migrations completed, local community hosts were seeded, desktop/web dependencies were installed, and Git hooks were installed.
- Healthy before teardown: `buzz-postgres`, `buzz-redis`, and `buzz-minio`.
- Running before teardown: `buzz-adminer` and `buzz-prometheus` (no Compose healthchecks configured).
- Unhealthy before teardown: `buzz-keycloak`. Its configured probe requests `/health/ready`, but Compose does not enable Keycloak health endpoints; the probe receives HTTP 404. The `dev-mem` H2 database also initialized 148 changesets successfully and later reopened empty, after which scheduled jobs reported missing `REALM` tables and the root endpoint returned HTTP 500.
- Data-preserving teardown: `docker compose down` removed the Buzz containers and network without `-v`. The named volumes `buzz-postgres-data`, `buzz-minio-data`, and `buzz-prometheus-data` remain.
- Host restoration: Postgres.app 17 again owns port 5432, Homebrew Redis again owns port 6379, and Homebrew PostgreSQL 14 is again loaded in its original port-conflicted `error 1` state.

## Baseline gates

### Buzz

- `. ./bin/activate-hermit && just ci`: FAIL at `node desktop/scripts/check-file-sizes.mjs`. Task 1 requires renaming `origin` to `upstream`, while the file-size base resolver defaults to the hardcoded ref `origin/main`; all gate lanes before that point passed.
- `CHECK_FILE_SIZES_BASE=b49675894b39f87215e4dfc8c1ad4a3c28c6097e just ci`: PASS. This explicit supported base override exercised the complete remaining gate.
- Rust tests: 4,643 passed, 0 failed, 234 ignored (1,563/0/215 in the root unit lanes; 3,080/0/19 in desktop Tauri workspace tests).
- Node tests: 5,766 passed, 0 failed (13 security-review, 6 file-size policy, 5,747 desktop).
- Flutter tests: 1,874 passed, 0 failed.
- Builds/checks: root Rust fmt/clippy, desktop Biome/policy checks, Tauri fmt/clippy/check, web checks, mobile format/analyze, desktop production build, and web production build all passed.
- Non-failing source diagnostics: desktop Biome reported 4 warnings and 5 infos; Vite reported large-chunk/code-splitting warnings.

### Hub

- `npm test`: PASS; 482 passed, 0 failed, 1 skipped.
- `npm run typecheck`: PASS.
- `npm run gate`: PASS; `gate_mockup_hash: OK`. `gate_no_check` explicitly skipped because `state/hub.sqlite` is absent.

## Failure classification

- Installation failures: none after required host prerequisites and port ownership were established.
- Pre-existing host blockers: Docker Desktop was initially stopped; Homebrew Redis occupied port 6379; Postgres.app occupied port 5432, and Homebrew PostgreSQL 14 attempted to claim it when it became free. These were resolved non-destructively and restored after verification.
- Source/fork baseline failures: exact `just ci` cannot resolve hardcoded `origin/main` after the required remote rename; Keycloak's health endpoint configuration is incomplete, and its in-memory H2 service later loses its initialized schema.
