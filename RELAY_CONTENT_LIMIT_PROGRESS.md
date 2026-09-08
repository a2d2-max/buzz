# 배포 때 Secret a2d2-buzz-env 에 넣을 줄

```text
BUZZ_MAX_EVENT_CONTENT_BYTES=524288
BUZZ_MAX_FRAME_BYTES=1048576
```

# Relay content limit progress

## Current state

- Phase: implementation, validation, live proof, and independent review complete; stage 7 signed local commit preparation in progress
- Branch: `a2d2-max/relay-content-limit`
- Base HEAD at task start: `b2978786cf2cbdf7b2876b16371ddc324d88a1b4`
- Worktree at start: clean
- Production code edits: relay config/ingest/NIP-11 and Docs bounded resolver/cache/save guard implemented; importer handoff documented without editing importer-owned files
- Current passing evidence: relay feature selection 52/52; post-review resolver/production-hook selection 34/34; Docs package 145/145; desktop package 6,749/6,749 across 86 suites; direct `just test` unit implementation 14/14 commands and 3,663/3,663 executed tests with 270 ignored; relay media 35/35, telemetry 1/1, and boot lifecycle 9/9; relay all-target clippy with warnings denied; final desktop check, typecheck, file-size core 10/10 and all surface scans, Rust formatting, and diff whitespace checks
- Current gate limitations: the required top-level `just test` command exited 1 before integration because its `_ensure-services` prerequisite checks only Docker-managed services, despite healthy isolated Postgres/Redis URLs. The same integration cargo lanes were run directly: the unchanged forbidden DB source guard remained 2/3, workspace integration stopped after 212 passes on two repeatable `buzz-agent` timeout failures (serial target 52/54), and the unrelated relay mesh echo remained 0/1 with HTTP 504. `buzz-auth` has no integration test target, which the script normally records as an expected skip.
- Resolved development failures: one Rust test-only compile assertion, initial missing desktop dependencies, six media tests pointed at a default missing-role database, one parallel tracing test, and one Docs screen fixture missing the newly required relay seams were corrected or rerun successfully without unrelated production edits
- Checked-in defaults: content 256 KiB and frame 512 KiB; these remain unchanged regardless of deployment measurements
- Deploy env: operator-confirmed 512 KiB content / 1 MiB frame pair shown above

## Stages

1. Read product, testing, and package contracts; map production and test seams. **Complete.**
2. Add relay content-size configuration and startup invariant; bind ingest and NIP-11 to it. **Complete.**
3. Add the Docs relay-info resolver/cache and wire save validation and limit-aware copy. **Complete.**
4. Expose the shared resolver contract for the separate importer worker; do not edit importer-owned files. **Complete.**
5. Run focused Rust and Node boundary/regression tests, then repository-prescribed desktop/type/file-size and isolated integration checks. **Complete with the explicit wrapper and out-of-scope baseline limitations above.**
6. Run fresh-binary live WebSocket proof: exact 512 KiB boundary, the measured-size synthetic Docs page, and the historical 300 KiB/default-vs-raised cases. **Complete: all 13 live assertions passed.**
7. Record evidence, complete independent review, address findings, and create signed local commits. **Review complete at 10/10 with no open findings; commits pending.**

## Seams and constraints

| Seam | Planned contract | Constraint / proof |
|---|---|---|
| config -> ingest -> NIP-11 | One loaded content limit controls ingest rejection and `limitation.max_content_length`; frame limit remains `max_message_length` | Boundary tests at limit - 1 / limit / limit + 1 using the production handler path |
| startup policy | Reject startup when frame bytes are less than content bytes + 64 KiB | Config-load tests must bind the actual startup configuration path; exact overflow handling must be checked |
| NIP-11 -> Docs cache -> publish | Resolve `limitation.max_content_length`, fall back to 256 KiB, cache per relay with the same expiry model as `docKindSupport.ts` | Node tests for fallback, per-relay isolation, expiry, community-switch abort before signing, and exact byte boundary |
| importer shared helper | Export one resolver usable by publish and dry-run; document the import and call shape here | Importer files are owned by another worker and will not be edited in this worktree task |
| ownership / conflicts | `req.rs` is forbidden; keep `nip11.rs` diff minimal | Stop and report if overlapping uncommitted edits appear |

## Risks and open inputs

- Fizz supplied a completed 3,319-event measurement: maximum codec content 395,552 B, maximum WebSocket EVENT message 406,682 B, maximum masked frame 406,696 B, and zero embedded base64. These are user-provided corpus results, not independently remeasured in this checkout.
- Raising the content limit increases per-connection decode/allocation pressure and relay fan-out cost; the frame setting must include at least 64 KiB of event-envelope headroom.
- The 64 KiB startup floor is only a configuration invariant. JSON escaping can make an EVENT frame approach twice the content bytes; candidate deployment pairs must reserve that larger practical envelope.
- `POST /events` has a separate fixed 1 MiB HTTP body layer. Fizz's measured maximum full frame (406,696 B) fits it, but this env pair does not raise that HTTP ceiling; complete HTTP bodies above 1 MiB must use WebSocket or receive a separately scoped HTTP change.
- Standard NIP-11 describes `max_content_length` in Unicode characters. This feature intentionally advertises and enforces UTF-8 bytes under the explicit Buzz brief; clients written to the standard wording may interpret the number differently.

## Importer handoff

The importer worker can reuse the pure byte-limit decision without importing the React hook:

```ts
import { resolveMaxContentBytes } from "../../src/features/docs/lib/docContentLimit.ts";

const maxContentBytes = resolveMaxContentBytes(relayInfo);
const contentBytes = new TextEncoder().encode(event.content).length;
if (contentBytes > maxContentBytes) {
  // refuse this item in both publish and dry-run
}
```

`resolveMaxContentBytes` accepts an unknown NIP-11 document, returns a positive safe-integer `limitation.max_content_length`, and otherwise returns 262,144. Importer publish and dry-run must call this same function on the same relay-info snapshot. This worker did not edit importer-owned files.

The import above is relative to `desktop/scripts/notion-import/relayContentLimit.ts`. The script must run from `desktop/` through the repository loader so the helper's `@/shared` imports resolve:

```bash
node --import ./test-loader.mjs --experimental-strip-types <script>
```

Plain Node fails on that alias. The separately owned importer still imports the removed `DOC_MAX_CONTENT_BYTES` and duplicates the positive-safe-integer parser; its owner must replace both with this helper before the combined feature can compile and share one decision.

## Transport rationale

- Fizz supplied separate corpus maxima: 395,552 B codec content, 406,682 B WebSocket EVENT message, and 406,696 B masked frame. They are not asserted to come from the same event.
- The selected 524,288 B content limit leaves 128,736 B above the maximum supplied content measurement. The 1,048,576 B frame limit leaves 641,894 B above the maximum supplied EVENT message and 641,880 B above the maximum supplied masked frame.
- Axum 0.8.9 delegates the configured inbound frame and assembled-message bounds to tungstenite 0.29.0. The router applies the same config value to both. The 64 KiB startup rule only rejects obviously inconsistent settings; JSON escaping and large tags can consume more.
- Count-bounded queues can retain materially more bytes after this operator override: Redis pub/sub, Tokio broadcast capacity, the 1,000-message per-connection send buffer, and 1,000-row history pages remain rollout metrics to watch.
- Primary sources: [NIP-11 Relay Information Document](https://github.com/nostr-protocol/nips/blob/master/11.md?plain=1), [axum 0.8.9 `WebSocketUpgrade`](https://docs.rs/axum/0.8.9/axum/extract/ws/struct.WebSocketUpgrade.html), [tungstenite 0.29.0 `WebSocketConfig`](https://docs.rs/tungstenite/0.29.0/tungstenite/protocol/struct.WebSocketConfig.html), [Tokio 1.52.3 broadcast](https://docs.rs/tokio/1.52.3/tokio/sync/broadcast/index.html), and [Redis client handling](https://redis.io/docs/latest/develop/reference/clients/). Detailed source mapping remains in ignored `test-results/relay-content-limit/operator-candidate-research.md`.

## Evidence log

- 2026-09-08: Hermit activation succeeded. Initial `git status --short --branch` showed only the branch header and no tracked or untracked changes.
- 2026-09-08: `crates/buzz-relay/AGENTS.md`, `desktop/AGENTS.md`, and `desktop/src/features/docs/AGENTS.md` are absent; root `AGENTS.md` applies.
- 2026-09-08: Linked-worktree check resolved this checkout to `/Users/sign-x/orca/workspaces/buzz/relay-content-limit`, branch `a2d2-max/relay-content-limit`, sharing only the expected Git common directory with the main checkout.
- 2026-09-08: Startup policy chosen: reject an invalid frame/content pair. Requiring explicit paired operator settings avoids silently raising parser and allocation ceilings.
- 2026-09-08: Concurrent Tasks ownership tightened. Forbidden paths are `crates/buzz-relay/src/handlers/req.rs`, `crates/buzz-relay/src/handlers/close.rs`, `crates/buzz-db/src/store/event.rs`, and `crates/buzz-db/src/store/tag_filters.rs`. In `nip11.rs`, do not change `RelayInfo::build`, `supported_extensions`, or info handlers; only add `limitation.max_content_length` and set it through the existing document assembly seam.
- 2026-09-08: Relay stage implemented. `BUZZ_MAX_EVENT_CONTENT_BYTES` parses strictly as a positive `usize`, defaults to 256 KiB, rejects headroom overflow, and rejects startup when `BUZZ_MAX_FRAME_BYTES < content + 64 KiB`. The production ingest entry reads the loaded config before database or signature work. NIP-11 adds only the limitation field plus the existing `nip11_document` config assignment; `RelayInfo::build`, supported extensions, and handlers remain untouched.
- 2026-09-08: Fizz/operator set the deployment pair to `BUZZ_MAX_EVENT_CONTENT_BYTES=524288` and `BUZZ_MAX_FRAME_BYTES=1048576`. Defaults remain 262,144 / 524,288. Validation must cover 524,288 accepted, 524,289 rejected, the original 300 KiB/default-vs-raised proof, and a synthetic size-matched Docs fixture with exactly 395,552 B codec content when the original page is unavailable.
- 2026-09-08: First `cargo test -p buzz-relay config::tests --lib` attempt compiled dependencies, then failed before running tests: the new ingest assertion attempted `Debug` formatting on `IngestResult`. The assertion was changed to pattern-match without expanding the production API, and its rerun passed.
- 2026-09-08: Relay config lane rerun passed 50/50 tests with 1,087 filtered out.
- 2026-09-08: Docs stage implemented in adjacent `docContentLimit.ts`: pure `resolveMaxContentBytes(relayInfo)` for importer reuse, per-relay localStorage caching with the existing 24 h doc-kind expiry, safe 256 KiB fallback, and a two-read relay generation fence. A community switch during NIP-11 lookup aborts the save so old-community content cannot be signed or published on the new relay. `useCommunityDocs` resolves the current limit before signing every publish and includes the actual relay limit in `DocTooLargeError`.
- 2026-09-08: Initial focused Node command launched 3 test files but all 3 failed before test discovery because `typescript` was absent from `desktop/node_modules`; `pnpm install --frozen-lockfile` started. No product assertion ran in that attempt.
- 2026-09-08: Frozen desktop install completed. Focused Node rerun passed 44/44 across `docContentLimit`, `docPageCodec`, and the production `useCommunityDocs` hook. It covers fallback/malformed NIP-11, per-relay cache and exact expiry, delayed old-community metadata, default 300 KiB pre-sign refusal, and configured 524,288/524,289-byte save boundaries.
- 2026-09-08: Production Rust ingest boundary test passed 1/1 at 524,287 / 524,288 / 524,289 B; the configured NIP-11 limitation test passed 1/1.
- 2026-09-08: Entire Docs package passed 138/138 under Hermit Node. Existing React `act(...)`, intentional relay-timeout, and timer-overflow test noise appeared without failures.
- 2026-09-08: `just desktop-check` passed (Biome reported unrelated pre-existing informational/style warnings only); `just desktop-typecheck` passed; `just file-size-check` passed its 10/10 core tests and desktop/web/mobile surface scans.
- 2026-09-08: Ignored independent-review package prepared at `test-results/relay-content-limit/implementation-review.md`, based on `b2978786`, with the changed/untracked file inventory, review commands, behavior checklist, and current evidence.
- 2026-09-08: Initial independent-review `git diff -U10` snapshot (including new source/test/progress files, status/stat, and an empty forbidden-path diff) used SHA-256 `9c0d5343bfdcee80ed4db08e9583f481427f1226d9ebc97cedfa526e1805ca96`; it was superseded after review fixes.
- 2026-09-08: After tightening metadata-time community-switch handling to abort, the focused resolver/production-hook selection passed 28/28, including zero signatures and zero publishes across that switch. A whole desktop rerun on that intermediate code passed 6,743/6,743. `just desktop-check` and `just desktop-typecheck` both passed with unrelated baseline warnings only.
- 2026-09-08: First full `cargo test -p buzz-relay --lib` run executed 1,048 tests: 1,040 passed, 8 failed, 89 ignored. Six media failures used the default local Postgres and failed because role `buzz` did not exist; `telemetry::tests::trace_context_lookup_does_not_enable_callsites` observed another parallel test's global subscriber; `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` returned 504 instead of 200. The new ingest and NIP-11 tests passed in this run.
- 2026-09-08: Final-code full desktop package rerun passed 6,743/6,743 tests across 86 suites with zero failures.
- 2026-09-08: Required `just test` was attempted with the review worker's isolated `DATABASE_URL` and `REDIS_URL`. Its unit phase ran, but the integration phase always invokes `_ensure-migrations` and then `_ensure-services`; that repository recipe tried the Docker-managed path and timed out with `Recipe _ensure-services failed with exit code 1`, so `just test` exited 1 before its integration lanes. The same cargo lanes were then run directly against those isolated services, with results recorded below.
- 2026-09-08: Fresh `target/debug/buzz-relay` live proof passed every requested assertion. With the final 524,288 / 1,048,576 pair, NIP-11 advertised both exact values; raw 524,288 B content was accepted and read back, raw 524,289 B was rejected while the socket remained usable, with actual serialized EVENT sizes 524,732 / 524,733 B and calculated masked single-frame sizes 524,746 / 524,747 B. The production Docs hook signed once, published, stored, and read back a synthetic size-matched 395,552 B codec payload; its EVENT was 395,994 B and calculated masked frame 396,008 B. The original measured page was unavailable, so this proves the byte boundary and production save seam rather than its original escaping/tag distribution.
- 2026-09-08: Historical and default live variants also passed. A 1,048,576 / 2,162,688 configuration saved and read back a synthetic 307,200 B Docs payload (EVENT 307,642 B; calculated masked frame 307,656 B). With both env variables absent, NIP-11 advertised 262,144 / 524,288; the production Docs hook rejected 307,200 B before signing or publishing, raw 262,144 B was accepted (EVENT 262,588 B; calculated masked frame 262,602 B), and raw 307,200 B was rejected without disconnect (EVENT 307,644 B; calculated masked frame 307,658 B). A 524,288 B content / 589,823 B frame startup exited 1 with the required +65,536 diagnostic. Detailed reproduction evidence is in ignored `test-results/relay-content-limit/live-evidence.md`.
- 2026-09-08: Direct `cargo test -p buzz-db -- --nocapture` against the isolated URLs ran its library as 122 passed / 0 failed / 252 ignored, then `observability_source` as 2 passed / 1 failed. The deterministic source guard `p0_pool_acquisitions_use_typed_operation_pairs_without_other` flags an existing `.fetch_all(pool)` in the unchanged, forbidden `crates/buzz-db/src/store/event.rs`; the base-to-worktree diff for that path is empty, so this remains an explicit out-of-scope baseline failure. `buzz-auth` has no integration test target, matching the script's expected skip branch.
- 2026-09-08: Direct `cargo test --test '*' -- --nocapture` reached 212 passing tests before exiting at two `buzz-agent` regression failures: `context_recovery_budget_exhaustion_waits_for_delayed_stderr` timed out receiving delayed stderr and `tool_metadata_caps_enforced` timed out listing fake MCP tools. A serial full-target rerun reproduced the same 52 passed / 2 failed result, establishing these as persistent out-of-scope failures rather than test-process parallelism.
- 2026-09-08: The prior relay-library failures were rechecked serially with the isolated URLs. The full `api::media::tests::` module passed 35/35, including the six tests that had failed against the default missing-role database; `telemetry::tests::trace_context_lookup_does_not_enable_callsites` passed 1/1. The unrelated mesh echo test still failed 0/1 with HTTP 504 instead of 200. The affected relay `boot_lifecycle` integration target passed 9/9.
- 2026-09-08: A direct rerun of the `just test` unit implementation (`./scripts/run-tests.sh unit`) passed all 14/14 command steps in 100 seconds. Summed command result lines were 3,663 passed / 0 failed / 270 ignored; the three scoped relay commands reported 3,391 filtered tests. Per-command counts are retained in ignored `test-results/relay-content-limit/direct-unit-rerun.log`.
- 2026-09-08: Independent gstack review placed a HOLD on two Docs P1s: unbounded/stallable NIP-11 retrieval and a missing generation fence across awaited signing. Five production-bound checks first failed against the prior code within a 29/34 focused result: never-resolving fetch, stalled body, oversized-body cancellation, production-save timeout fallback, and signing-time community switch. The resolver now bounds the complete metadata operation to 5 seconds and 64 KiB, cancels declared or streamed oversize bodies, and falls back to 262,144 without caching failures. The save path retains the relay URL returned with the limit, re-reads it after signing, and begins `publishEvent` immediately after a successful comparison. Focused resolver/hook rerun passed 34/34, including zero publish attempts during a delayed-sign switch.
- 2026-09-08: Scoped independent re-review passed at 10/10 with no open findings. Post-fix live production-hook smokes again stored/read back the synthetic 395,552 B page (EVENT 395,994 B; calculated masked frame 396,008 B) and rejected 307,200 B before signing at the 262,144 B default. The owned relay, Postgres, and Redis processes were then stopped and their loopback ports verified closed.
- 2026-09-08: The final Docs package passed 145/145 after its screen fixture was updated to model the production relay URL and NIP-11 seams. Final whole desktop passed 6,749/6,749 across 86 suites. The post-fix `just file-size-check` passed 10/10 core tests and every desktop/web/mobile scan.
- 2026-09-08: `cargo clippy -p buzz-relay --all-targets -- -D warnings` passed. Final `cargo fmt --all -- --check` and `git diff --check` passed.
- 2026-09-08: The final ignored review package was refreshed after all checks. Compared with the scoped-reviewed `2112d3a0...04d4c` snapshot, production files did not change; only `DocsScreen.test.mjs` gained the relay URL/NIP-11 fixture required by the final full Docs run, and the progress ledger was finalized. Its exact final hash is recorded in ignored `implementation-review.md` to avoid a self-referential tracked ledger.
- 2026-09-08: Skills used: `/Users/sign-x/.agents/skills/superpowers/receiving-code-review/SKILL.md` for technically verifying and addressing the independent findings. Coordinator-owned workflow skills were reported as `/Users/sign-x/.agents/skills/superpowers/subagent-driven-development/SKILL.md` and `/Users/sign-x/.agents/skills/superpowers/using-git-worktrees/SKILL.md`.
