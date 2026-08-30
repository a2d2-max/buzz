# Ops bridge compatibility matrix

Tested pair: Buzz `7fa62841f3be0fa7a419c0d6b5d6fce70c9d1757` (dirty: `false`) ↔ Hub `dfdd6a36d2ac3ff0ae9de53330e5fb8319e4e741` (dirty: `false`). Fixture `f1eb9aaaa6948bc8ffd8aef067b9de401f79941e6aee44458bd14f6f4174a499`.

Tested artifacts: inline `f8eb6d8c6a3e213ba332648c4f5af64599924b9684c9c12246b3b62c6b522a6a`; opaque `b105bfde1f5f8aca1238b50b167d2a4acd5d17b9f591d640cc014bed25706650`.

| Surface | Contract | Hub support | Buzz support | Evidence |
| --- | --- | --- | --- | --- |
| Capabilities | v1 exact reads and module metadata | snapshot, events, artifact | strict v1 parse | native startup + Ops bridge unit tests |
| Snapshot | `/ops-bridge/v1/snapshot` | room/session/checklist/decisions | fail-closed schemas | all three native viewports |
| Events | `/ops-bridge/v1/events` | SSE sequence | generation-bound watch/ack | bridge contract tests |
| Timeline page | `/ops-bridge/v1/timeline` | paged v1 + revision/cursor | page-endpoint-only module | bridge contract tests |
| Artifact page | `/ops-bridge/v1/artifacts` | paged v1 + revision/cursor | page-endpoint-only module | bridge contract tests |
| Artifact inline | preview manifest/content | text/markdown | inline text verification | 1280px, 736px, 390px |
| Artifact opaque | preview manifest/content chunks | text/plain >1 MiB | bounded handle reads + release | 1280px, 736px, 390px |
| Artifact errors | stable public error enum | invalid/not found/denied/integrity/size/media | typed fail-closed mapping | bridge/Rust tests |
| Mutations | disabled fixture | drafts/transitions empty | local Ops read-only | counters all zero |

Paged modules are not interpreted as inline snapshot payloads. Non-paged advertised payloads remain fail-closed when absent or invalid. Replace the tested SHA pair and dirty flags after the final clean integration run.
