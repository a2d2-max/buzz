# Native Ops artifact evidence

## Reproduction

- Working directory: `desktop`
- Evidence command: `'pnpm' 'test:native:ops-artifact'`
- Native harness contracts: `pnpm test:native:ops-artifact-harness`
- Ops bridge contracts: `node --import ./test-loader.mjs --experimental-strip-types --test src/features/ops-room/opsBridge.test.mjs`
- Hub fixture contracts: `npm run test:one -- tests/hub/testing/ops-room-fixture.test.ts`
- Rust offline focus: `CARGO_NET_OFFLINE=true cargo test --lib --no-default-features evidence_offline`
- Rust full no-default-features: `CARGO_NET_OFFLINE=true cargo test --lib --no-default-features`
- Static gates: `cargo fmt --check`, `pnpm typecheck`, and `pnpm exec biome check tests/native src/features/ops-room/opsBridge.test.mjs src/features/ops-room/types.ts`

## Immutable inputs

- Buzz SHA: `7fa62841f3be0fa7a419c0d6b5d6fce70c9d1757` (dirty: `false`)
- Hub SHA: `dfdd6a36d2ac3ff0ae9de53330e5fb8319e4e741` (dirty: `false`)
- Fixture hash: `f1eb9aaaa6948bc8ffd8aef067b9de401f79941e6aee44458bd14f6f4174a499`
- JSON manifest SHA-256: `7aef43c7f388c383b25b79026175b9c9d4dbd2883d4e5e598f7a8354a7ed03ee`

| Read path | Fixture | MIME | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| inline | evidence-summary.md | text/markdown | 63 | f8eb6d8c6a3e213ba332648c4f5af64599924b9684c9c12246b3b62c6b522a6a |
| opaque handle | evidence-large.txt | text/plain | 1052672 | b105bfde1f5f8aca1238b50b167d2a4acd5d17b9f591d640cc014bed25706650 |

## Viewport evidence

| Layout | Logical viewport | Inline screenshot | Inline SHA-256 | Opaque screenshot | Opaque SHA-256 | Network observations | Non-loopback sockets | Cleanup/focus |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| desktop | 1280×900 | artifact-inline-1280.png | 4446f3f1bdbb727b866b0a42dc2cdfa40b0089ac0856337350b915bf80242719 | artifact-opaque-1280.png | 80c521a131e8177cd511a2489911bf1649441b6a16df28c8713446c308826041 | 801 | 0 | yes |
| compact | 736×900 | artifact-inline-736.png | 19ac017647259056b3dc8e023993075d27ba800a339648408b44568a9f649b5e | artifact-opaque-736.png | 1e341f245f5ae512b9a6be2ba4c536b2da00c837f10b4eb4d479843afb7f6948 | 207 | 0 | yes |
| mobile | 390×844 | artifact-inline-390.png | dc15a4720e2fcb75e1ea0aac2f363d1978fbbf9e77d23d266cf74a66d47b0d3a | artifact-opaque-390.png | 8bb2b19df8bcc9512739c708f21a230cc3bc0b834dec70de42dd68f89cc2ab12 | 207 | 0 | yes |

Each viewport also has matching accessibility JSON and a redacted process log; their hashes are recorded in `manifest.native.json`. Both readers returned focus to their exact trigger. Every Tauri process group exited, stdout/stderr drained, and each opaque handle directory contained only its owned marker.

| Evidence file | SHA-256 |
| --- | --- |
| artifact-inline-1280.png | 4446f3f1bdbb727b866b0a42dc2cdfa40b0089ac0856337350b915bf80242719 |
| artifact-inline-1280.accessibility.json | 61b0c443f08b55ee0b075c57b072c3cda6e6e2961de1b486a4e6ab0d0f54536b |
| artifact-opaque-1280.png | 80c521a131e8177cd511a2489911bf1649441b6a16df28c8713446c308826041 |
| artifact-opaque-1280.accessibility.json | 3fd7817bc4758e9330206d24c9fb1157ae871eff356e73b0dffc0a722decc445 |
| artifact-1280.log | 983d2bbb51499f54d18cb64b024db2df30c081f620d213e0c4a3a7c5b6e5acb4 |
| artifact-inline-736.png | 19ac017647259056b3dc8e023993075d27ba800a339648408b44568a9f649b5e |
| artifact-inline-736.accessibility.json | 159fd836025d0448109d42e53ccd58e5b50c4d43c736f609e1a403d468e22d31 |
| artifact-opaque-736.png | 1e341f245f5ae512b9a6be2ba4c536b2da00c837f10b4eb4d479843afb7f6948 |
| artifact-opaque-736.accessibility.json | e836235faf1361e3c77fd78070eae43bd170029d43c084f7588f34edf7cc29c3 |
| artifact-736.log | 0a506aef878d0368cd12d357626ded633cb71727116b4ead484e8f0500daaffb |
| artifact-inline-390.png | dc15a4720e2fcb75e1ea0aac2f363d1978fbbf9e77d23d266cf74a66d47b0d3a |
| artifact-inline-390.accessibility.json | 04cbda31742a82b5ed1c24335aaad99bcc3add33b33ff9abff97187f36753015 |
| artifact-opaque-390.png | 8bb2b19df8bcc9512739c708f21a230cc3bc0b834dec70de42dd68f89cc2ab12 |
| artifact-opaque-390.accessibility.json | d17366078ff820e8f8ac5a0df8fa788661540b20b7e53a8b69cd66cd6cb59fac |
| artifact-390.log | 1c5bc66a794a602c23b1d3b127c1e78f9fe112603e3818536fc1975b09034468 |

## Side-effect counters

| Counter | Value |
| --- | ---: |
| delivery_callback_count | 0 |
| provider_execution_count | 0 |
| external_network_client_count | 0 |
| mutation_request_count | 0 |

Offline evidence mode was enabled before Tauri startup. Cargo and pnpm were forced offline, shared HTTP clients were routed to a fail-closed loopback proxy, STT/TTS/mesh startup fetches, managed-agent restore/spawn, the system process sweep/reaper, and periodic event publishing were disabled. Process-group sockets were continuously sampled, and logs were rejected on missing offline-policy markers, download markers, or non-loopback URLs before redaction.

## Limitations

- This run proves the macOS Tauri/Orca lane and the tested Buzz/Hub SHA pair only.
- Retina screenshots are 2× pixels while the accessibility manifest records exact logical viewport dimensions.
- A dirty SHA pair is development evidence and must be regenerated from a clean integrated worktree before release acceptance.
