# Task 5 Buzz consumer report

Date: 2026-08-30

Base: `885895df10de9c9d920a80a6bf3edfd608431434`

Frozen spec: `eca186f66fd1c8c450a266bfa36c8458528170c9`

Dormant Hub contract: `3697532b733759d7d4b80530b21d9378c5a6dd92`

## Outcome

Implemented the strict Buzz-only Rust, Zod, native bridge, page/detail, snapshot, and module-state consumers required before Task 5 producer advertisement. No Hub producer, materializer, advertisement, external provider/network action, mutation control, or UI redesign was added.

Capability handling now validates each exact wire-open record before narrowing its name, rejects duplicate or malformed unknown names globally, ignores only valid future names, and converts malformed known records to bounded name-only native markers. Known topology mismatches and advertised invalid or absent payloads become module-local `contract_invalid`; unrelated reads remain mountable and the shared invalid-module aggregate disables Ops mutations.

Task 5 snapshot, page, and detail DTOs have exact Rust and Zod consumers sharing the Task 3 public boundary. They cover closed keys and enums, explicit nullability, safe/positive integer limits, 2 MiB bounds, NFC/calendar/path/credential/internal-tag rejection, uniqueness, cardinality, readiness aggregates, canonical order, and full-match public patterns. Research and repository overview shapes remain unchanged. Research page/detail failure is sticky at module scope after advertisement; repository detail failure remains detail-local.

The native client now has the fixed Teams activity route and exact source scope, corrected scope-free research overview query, fixed typed research/repository detail routes and Tauri commands, exact local `503 {"error":"unavailable"}` parsing, and bounded `contract_invalid` markers for malformed native responses. No mutation command was added.

## TDD evidence

RED failures observed before production changes included:

- Zod accepted or ignored malformed future capability records and filtered the two new known names.
- Rust erased malformed known capability records; the first safe-marker implementation also exposed a raw secret/path field.
- Task 5 DTO and typed request modules/functions were absent; wrong known topology became unavailable instead of invalid.
- Rust lacked Teams/detail request variants, routes, commands, and Task 5 decoders.
- Native snapshot validation was test-only and allowed malformed Task 5 module payloads to cross Tauri.
- Rust/Zod parity initially disagreed on safety-policy ordered subsets, connection kind ordering, optional overview `null`, and native page/detail contract-error isolation.
- Advertised research/Teams `unavailable` was returned as unavailable instead of sticky module-local invalid.

GREEN coverage includes:

- Capability exactness, topology, duplicates, valid future names, safe known-name markers, and raw secret/path non-disclosure.
- Connections, Teams page/scope, workflow/routing, safety policy, research/repository overview, and both detail DTOs.
- Shared unsafe-public-text corpus, calendar timestamps, hashes/tokens, order, uniqueness, cross-field readiness, nullability, and response bounds.
- Fixed native routes/queries, exact unavailable errors, typed contract-invalid errors, command registration, snapshot sanitization, and module-local isolation.
- Compatibility fixtures for old Hub/new Buzz, new Hub/old Buzz dormant, valid future module, malformed known isolation, and first-load/no-token/no-Hub guest behavior.

## Verification

### Reviewer fix loop

An independent committed-HEAD review found six important boundary gaps. Each was reproduced before its fix:

- Recognized page-error statuses with malformed JSON/content type/envelopes or the wrong status/error pairing returned generic `HttpStatus`. They now become native `ContractMismatch`, which Tauri exposes only as bounded `{error:"contract_invalid"}`.
- An advertised repository overview `503 unavailable` was incorrectly treated as unavailable. Both advertised overview routes now latch module-local `contract_invalid`; only repository detail retains its explicit local-unavailable exception.
- Research overview/detail invalid state was write-only. The shared page-state authority now checks the sticky same-revision latch before a request and generation-fences both successful and failed deferred completions.
- Native snapshot revision did not enforce the JavaScript-safe maximum. Rust now rejects it before Tauri, and Zod carries the explicit same maximum.
- Research/repository detail response IDs were not bound to the requested ID. Both Rust and TypeScript now reject mismatches.
- Rust/Zod parity coverage now exercises the exact/over 2 MiB boundary; 64-row plan, route, and evidence limits; 16-entry routing/policy arrays; active-session, count, and version bounds; and full-match hash/comparison-SHA prefix, suffix, and uppercase negatives. The dormant compatibility fixture also executes through a frozen pre-Task-5 parser instead of only the new parser.

The page-state implementation was split into `opsPagedModuleState.ts` to keep the file-size ratchet while centralizing sticky and generation-fenced state.

- Focused TypeScript Task 5/overview/parity: 26 passed, 0 failed.
- Focused Rust Ops bridge: 60 passed, 0 failed.
- TypeScript typecheck: passed.
- Full desktop TypeScript: 6,004 passed, 0 failed.
- Full desktop Rust: 3,068 passed, 0 failed, 18 ignored; integration groups 7/7 and 3/3 passed.
- Touched Biome check: passed.
- `cargo fmt --check`: passed.
- Differential file-size gate against the required base: passed after splitting Task 5 Rust/page-detail/capability modules and the Task 5 TypeScript bridge/contracts.
- `cargo clippy --all-targets -- -D warnings` passed with only four explicit allowances for pre-existing baseline lints (`derivable_impls`, `items_after_test_module`, `single_match`, `useless_vec`). The unallowed run reported only those existing files/lints and no Task 5 diagnostic.
- `git diff --check`: passed.
- Playwright was not run because no rendered UI behavior or E2E mock boundary was changed.

## Self-review

- Confirmed all changed production paths are Buzz consumers under `desktop/`; there are no Hub changes.
- Confirmed valid unrelated snapshot/core data survives malformed known Task 5 modules and unsafe raw module fields do not cross Tauri.
- Confirmed malformed native success/error payloads produce bounded local markers rather than raw payload pass-through.
- Confirmed Teams, research, and repositories share the existing revision-keyed sticky invalid-state aggregate; repository detail does not poison overview.
- Confirmed no Task 5 mutation, provider execution, Teams send, GitHub/Git mutation, push, merge, publish, deploy, or external network capability was introduced.
