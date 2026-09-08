# Notion publication preparation handoff

## Decision

Local preparation and a locked, runnable Buzz CLI execution path are
implemented. No production upload, signer access, signing, publication, or
event/media readback was performed. The current corpus is **not ready to
execute**: production URL bindings and signer confirmation are absent, 41
unique assets use relay-incompatible source formats, and deployed media limits
have not been runtime-verified.

The Desktop/Tauri adapter remains a source-level inventory only. Its renderer
APIs cannot run in the Node process that owns the durable journal. The selected
execution host is the Node `BuzzCliPublicationApi`, backed by the existing Rust
`BuzzClient` transport.

## Commits and shared dependency

- importer base: `23ce4573c587c0550cff6c8b5bf9670744e23dac`
- authorized shared integration head: `2629f5a1da23eb5774932c41becd53ed2f94b2a8`
- shared Docs limit implementation: commit
  `6921aa337d718ffba3265bbb60e908ce2ccb2cd8`, path
  `desktop/src/features/docs/lib/docContentLimit.ts`
- final DCO-signed local merge commit: recorded in the external preparation
  report after the commit containing this file is created

The lockfile conflict was a compatible importer/TV union, not a semantic
version collision. Importer additions are `core-util-is@1.0.3`,
`@types/node@26.4.1`, `@types/unzipper@0.10.11`, and `csv-parse@7.0.2`; the
shared TV addition includes `core-js@3.50.0`. `pnpm install --lockfile-only`
resolved the importer peer snapshot on Node types 26 without dropping either
importer or TV packages.

## Full-data evidence

Private evidence root:

```text
/Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09
```

Source evidence is retained separately and unchanged:

- source ZIP SHA-256:
  `032706c9046e1057dbc3f7aa99dcb4c0d92e2d1c93557ed70ab341f418775996`
- source ZIP bytes: 674,909,878
- source intermediate SHA-256:
  `743b138f48de84ec78e240fb0f0c6dfece617a90d391a03410f7a4a770d2b033`
- pages: 3,319; unique stable IDs: 3,319; valid non-root parents: 3,135
- stable `(id,parentId)` SHA-256 for source, prepared, and simulated-final:
  `7f1e8bcf4d3a4c5128364a0a83ceeb9f5af222db439de18773a736a5ee796c3c`

Attachment denominators:

| Measurement | Count |
|---|---:|
| ZIP archive entries | 4,011 |
| ZIP binary entries / unique byte hashes | 436 / 431 |
| inline binary entries / unique byte hashes | 7 / 7 |
| combined binary entries / unique byte hashes | 443 / 438 |
| ZIP binary references | 550 |
| total binary body references | 557 |
| unreferenced ZIP binary entries | 0 |
| CSV originals / unique byte hashes | 256 / 204 |
| raw archive CSV references consumed by table conversion | 133 |
| unreferenced CSV originals | 126 |
| extracted ZIP binary / CSV / inline files | 436 / 256 / 7 |

Every retained entry records its byte size, CRC-32 where applicable, SHA-256,
and extraction identity. CSV originals remain evidence and are excluded from
the binary upload denominator. All 133 raw CSV references were consumed by the
database-table conversion; no final Markdown destination resolves to a retained
CSV original.

The simulated binding pass replaced 557/557 parser-owned destinations and left
zero local attachment placeholders or data URLs in final bodies. It validated
3,319/3,319 pages through the production Docs codec and the operationally
advertised 524,288-byte content limit, with 3,319 candidate events and the
1,048,576-byte frame limit retained only as provenance. Because bindings are
simulated, production binding/signing/publication readiness remains false.

Per-asset compatibility is in `notion-publication-compatibility.json`. Its
current summary is:

- assets: 438; source bytes: 1,213,717,718; largest: 189,907,502 bytes
- CLI upload format-blocked: 41 (25 M4A, 7 MOV, 9 SVG)
- MP4 requiring relay runtime validation: 8
- Desktop 50 MiB readback-blocked: 5
- Buzz CLI explicit readback-cap blocked: 0; the transport is wired but no
  production readback was performed
- deployed upload limits runtime-verified: false
- production live upload/readback/sign/publish counts: 0/0/0/0

Credential-free `ffprobe` inspection parsed all 40 ISO-BMFF inputs: 25 M4A are
audio-only, 7 MOV use the QuickTime container, and 8 MP4 contain a video track.
This does not replace relay validation; it only explains the per-asset blockers.

## Actual execution path

```text
Node execute-publication
  -> JsonPublicationJournalStore (exclusive lock + per-item durable records)
  -> buzz publication identity (configured public relay and signer; no network)
  -> buzz upload file
     -> BuzzClient::upload_file
     -> kind:24242 Blossom auth
     -> PUT /upload
  -> buzz media get
     -> authenticated same-origin GET /media/<sha256>.<ext>
  -> buzz publication query-doc
     -> NIP-98 POST /query for kinds 30623+30078 and #d=doc:<pageId>
  -> buzz publication sign-doc
     -> BuzzClient::sign_event for strict kind 30623 Docs input
  -> buzz publication publish-doc
     -> NIP-98 POST /events with the exact persisted signed event
  -> signature-verified exact event readback through /query
```

The Node process never reads or prints private-key/auth-tag values. The child
`buzz` executable inherits the already-provisioned environment and the importer
passes no credential or relay override flags. Target and public signer are
checked against explicit authorization before any upload.

## Reproduce local preparation

From the repository root, with Hermit active:

```bash
. ./bin/activate-hermit
cd desktop
node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts prepare-publication \
  --input /Users/sign-x/.buzz/RESEARCH/notion-import-run/notion-import.json \
  --output /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09 \
  --relay wss://buzz.a2d2lab.com \
  --operational-target wss://buzz.a2d2lab.com \
  --simulate-bindings-origin https://simulation.invalid
```

This command performs only the explicitly allowed public `/info` GET. Run it
twice to rehash every retained file and verify deterministic manifests.

## Relevant isolated checks

```bash
. ./bin/activate-hermit
cargo test -p buzz-cli
cargo clippy -p buzz-cli --all-targets -- -D warnings
cd desktop
./node_modules/.bin/tsc --noEmit -p scripts/notion-import/tsconfig.json
node --import ./test-loader.mjs --experimental-strip-types --test \
  'scripts/notion-import/*.test.mjs'
```

The importer suite covers upload failure, interruption and resume, exact signed
event reuse, duplicate/remote conflict, source/journal identity conflict,
post-binding oversize, relay false-success, forged readback, cross-origin media,
generic attachment upload, CLI execution-host binding, and concurrent journal
writers. The deterministic CLI fixture uses the explicit secp256k1 test secret
`00...01` only; it is not a claimed production identity.

The final local self-review found and fixed five concrete failure modes before
handoff: a descriptor could previously prove only its own remote hash instead
of equality with the source hash/bytes; a tampered effective content limit was
not bound back to its advertisement; a per-page journal record was not
rechecked against its page/parent/source identity; two `d` tags could pass when
the first was malformed; and CLI media readback buffered without an explicit
500 MiB ceiling. Regression tests now cover each affected production seam.

## Production execution and resume

Do not run this until every checklist item below is confirmed. Build the exact
checked-out CLI and then invoke the locked entry point from `desktop/`:

```bash
cargo build --release -p buzz-cli
cd desktop
node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts execute-publication \
  --input /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-prepared.json \
  --assets /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-assets.json \
  --private-assets /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-assets.private.json \
  --compatibility /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-compatibility.json \
  --content-limit /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-preflight.json \
  --output /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09 \
  --journal /Users/sign-x/.buzz/RESEARCH/notion-publication-prep-2026-09-09/notion-publication-journal.private.json \
  --buzz-cli ../target/release/buzz \
  --target-relay wss://buzz.a2d2lab.com \
  --signer-pubkey CONFIRMED_64_HEX_PUBLIC_KEY \
  --authorize-live
```

Resume uses the exact same command, inputs, target, signer, and journal path.
The source/corpus/asset identities are conflict-protected. A signed event is
durably stored before submit; an ambiguous retry re-queries before resending the
same event ID, never a newly signed replacement.

## Required production checklist and unresolved dependencies

- [ ] Coordinator explicitly authorizes live execution for this exact corpus.
- [ ] `buzz publication identity` in the approved authenticated environment
  confirms the exact target relay and public signer without exposing key data.
- [ ] The 25 M4A, 7 MOV, and 9 SVG assets are converted through an approved
  content-preserving policy or supported by an already-reviewed relay change;
  regenerate all manifests and re-run the full preflight afterward.
- [ ] Deployed image/GIF/video/generic-file size limits and MP4 validation are
  confirmed for all 438 source hashes. `/info` does not advertise media limits.
- [ ] Production upload descriptors and same-origin byte readback bind 557/557
  destinations; no simulation or local placeholder is accepted.
- [ ] Final bound 3,319-page corpus passes the production codec, parent/ID
  checks, and advertised content limit as a whole before signing starts.
- [ ] No remote Docs page differs from the prepared content at preflight or the
  immediate pre-publish recheck.
- [ ] Fizz/coordinator confirms the shared Docs/UI deployment. Conversion and
  codec checks are not actual Docs UI validation.
- [ ] The current runtime has no `mcp__buzz_dev_mcp__shell`; if a future
  authenticated environment supplies it, inspect only public target/signer
  identity before a separately authorized run.

No push, merge to an integration branch, deployment, PR, external message, or
production operation is part of this handoff.
