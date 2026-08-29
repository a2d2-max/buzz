# Native Ops Room evidence manifest

Native screenshots were captured at `2026-08-29T17:13:38Z`; the auditable evidence bundle was finalized at `2026-08-29T17:26:29Z` from an isolated local Hub fixture and the native Buzz Tauri application.

## Revisions

- Buzz runtime commit: `7f6ab108339fe6cfad931eb7b3a2a6e1211f4a7b`
- Hub fixture commit: `f7711f022252c8765ee2f4b3ec43d335ac1bf2c0`
- Public Ops contract version: `1`
- Fixture state basename: `buzz-ops-evidence.z99RVtRhM7`
- Fixture ownership marker SHA-256: `426c0d2314effb5465426232486f916e5d9ff4ee8e19fb966337e74a6061ecf9`
- Final fixture database SHA-256: `e932e9e9796d6b48e519d1391523f8c6dc1db706c22cc29706f5b3fa9a53d5c5`

## Native captures

| Viewport | Layout | Screenshot SHA-256 | Result |
| --- | --- | --- | --- |
| 1280 × 900 | Four-pane desktop | `dd737f8bcf8c169575db2cf3d97d0d7a324082d04d5711181a9b64e50f4aeb21` | Pass |
| 736 × 900 | Two-column compact with context drawer | `0e1457a9c97a3f1f953cbcb2e7d5295c29e5f88939f6e77862ea80134f7e2a5f` | Pass |
| 390 × 844 | Single-pane tabbed mobile | `80314b580105a1bb47d25dfb48609e0c58d224e73b33a673f679a631f9ca6bfb` | Pass |

The actual native application rendered `Local Ops mode` without a private-key input. Workspaces, the nested session tree, timeline events, the decision question, approval, artifact, and 75% progress came from the authenticated local Hub read model. The 736px run also verified drawer focus entry and Escape focus restoration. The 1280px app process settled to 0.0% CPU while idle.

Each matching `*.accessibility.json` contains the native accessibility tree text, role/name hierarchy, element count, focused element, coordinate space, and truncation state. The 736px file contains three captures: drawer closed, drawer open with focus inside the context container, and after Escape with focus restored to the context trigger.

## Recovery and isolation

- Recovery sequence: `ready → stale cached snapshot → ready`
- Local credential hash unchanged across the recovery sequence: yes
- State directory mode: `0700`
- Credential file mode: `0600`
- Delivery callbacks: `0`
- Provider executions: `0`
- External network clients: `0`
- Mutation requests: `0`
- External messages, pushes, merges, publishes, and deployments: `0`

The four machine-written counters are committed verbatim in `isolation-counters.json` (SHA-256 `99ea3348a464d3d7a67ae60dce11a08fa851d71e651eb932a6bcd3236a2e15cd`).

## Automated evidence

- Mock Ops Room E2E: `3/3` passed with `pnpm exec playwright test --project=integration tests/e2e/ops-room.spec.ts`
- Local Ops guest subset: `7/7` passed with `pnpm exec playwright test --project=smoke tests/e2e/identity-lost.spec.ts --grep 'local Ops guest'`; the separate `local Ops banner` test is intentionally outside this exact grep
- Buzz native Ops bridge unit tests: `15/15` passed with `cargo test --manifest-path desktop/src-tauri/Cargo.toml ops_bridge -- --nocapture`
- Hub isolated Ops fixture file: `18/18` passed with `npm run test:one -- tests/hub/testing/ops-room-fixture.test.ts`
- Native console errors: `0`
- Native page errors: `0`
- Native warnings: `1` expected development-only updater-unavailable warning
- Horizontal overflow: none at all three viewports
- Reduced-motion and minimum-target assertions: passed in mock E2E

| Test evidence | SHA-256 |
| --- | --- |
| `ops-room-e2e.log` | `e4dd2532613c6f0a2f8cc4c374ad6eda9111708a03b5e3163d0201c228190447` |
| `local-ops-guest-e2e.log` | `e0f7632c6e9697b713843c6469b6ddb24c2c94beb8ffa6c2743717b9a7bdb019` |
| `buzz-ops-tests.log` | `64e4a362ea12ca0e0edfe69b08ac33427dac4cb540997f8c6eaf87d888d11628` |
| `hub-ops-fixture-tests.log` | `bdc1d43182321b6455f0d7b07737d4104afaff1dd6e6a18101b6c010b3d5b328` |

Native application logs were redacted while streaming. A pre-final raw diagnostic log was deleted after it exposed machine-specific paths and a transient development credential. The final logs are non-empty and the evidence directory passes the repository secret/path scan.

## Reproduction outline

Use task-scoped variables such as `$HUB_REPO`, `$BUZZ_REPO`, and `$OPS_EVIDENCE_DIR` when reproducing. Start the isolated Hub fixture from `$HUB_REPO`, activate the Buzz Hermit environment from `$BUZZ_REPO`, launch the Tauri app against the fixture, capture the three viewports, and confirm the four isolation counters remain zero. No external provider or delivery profile is required.
