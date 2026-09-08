# Notion Markdown & CSV importer

This tool converts a Notion “Markdown & CSV” export without contacting a
relay. Run it from `desktop/` through the repository TypeScript loader:

```bash
node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts convert \
  --zip /path/to/notion-export.zip \
  --output /private/path/notion-import-output \
  --report /private/path/NOTION_IMPORT_REPORT.md \
  --relation-column "exact relation header" \
  --relation-column "another exact relation header"

node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts publish \
  --input /private/path/notion-import-output/notion-import.json \
  --output /private/path/notion-import-output \
  --report /private/path/NOTION_IMPORT_REPORT.md \
  --relay wss://relay.example

node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts prepare-publication \
  --input /private/path/notion-import-output/notion-import.json \
  --output /private/path/notion-publication-prep \
  --relay wss://relay.example \
  --operational-target wss://relay.example \
  --simulate-bindings-origin https://simulation.invalid
```

The fourth command, `execute-publication`, is a real uploader/signer/publisher
and is intentionally shown later with its full safety checklist. Do not infer
live authorization from either dry-run command above.

`publish` is always a dry run. It performs a bounded NIP-11 metadata GET, then
writes unsigned inputs for the desktop signer. It never reads a key, opens a
WebSocket, publishes an event, or falls back to kind 30078.
Every input uses kind 30623, `d=doc:<pageId>`, `t=community-doc`, and the exact
page content shape shared with `docPageCodec.ts`.

The importer first requests `/info` with `Accept: application/nostr+json`.
Only a finite positive safe integer at `limitation.max_content_length` becomes
the effective UTF-8 content limit. A missing field uses the current shared
256 KiB compatibility default and is recorded as `source=legacy-assumption`
with `limitVerified=false`. `limitation.max_message_length` is a WebSocket
frame limit and is never used as the document content limit. A 404, 405, or
501 response from `/info` causes one same-origin request to the canonical `/`
NIP-11 endpoint. Redirects, timeouts, network failures, other HTTP errors,
malformed or oversized responses, invalid UTF-8, and invalid advertised values
stop the dry run with a nonzero exit. They never become a successful fallback.
If both metadata endpoints explicitly return 404, 405, or 501, the importer
uses the legacy 256 KiB assumption but records both statuses, an unsupported
reason, and an unverified limit instead of claiming an advertisement.
The response is capped at 64 KiB and both requests share one five-second
deadline. Reports record the endpoint, status, advertised value, effective
value, source, and whether an advertisement was verified. A present
`max_message_length` is also validated and recorded as frame provenance, but
is never substituted for `max_content_length`. `--operational-target` must
normalize to the exact `--relay`; only a successful advertisement from that
explicit target is marked operationally confirmed.

Pages above the effective advertised or compatibility limit are listed as
failures and omitted from the event list.
The publish step refreshes the JSON and Markdown reports with the unsigned
event and size-failure totals. Reports contain page IDs, byte counts, and
reason codes, never page bodies or titles.
The event JSON marks whether the batch is complete and counts valid inputs
whose direct `parentId` was rejected. A metadata or asset-preparation failure
atomically replaces the event, status, JSON report, and Markdown report with a
failure state so an older successful run cannot be mistaken for the latest
result.

Parser-recognized Markdown link, image, and definition data URLs are decoded
strictly, checked against their declared image MIME signature, deduplicated by
SHA-256, and written under `notion-inline-assets/`. Code fences and inline code
are untouched. The prepared body uses deterministic local placeholders. A
private manifest retains the exact reconstruction mapping; verification reads
the actual extracted files and reconstructs every affected original body to
the same SHA-256. Existing files are reused only when their hashes match. ZIP
attachments stay compressed; only entries with a matching byte size are
streamed and hashed for duplicate comparison.

Local placeholders are not publishable URLs. When any exist,
`readyForSigning=false` and `readyToPublish=false` until a later approved step
uploads the files, binds final URLs, and validates the final event bodies
again. The legacy `publish` command never marks an advertisement operational;
`prepare-publication` does so only when `--operational-target` exactly matches
the fetched relay. Local test advertisements omit that option and remain
`operationalAdvertisementConfirmed=false`.

## Full publication preparation

`prepare-publication` is the local, credential-free stage for the complete
archive. It does not read a signer, call an upload endpoint, open a WebSocket,
or publish an event. It performs these operations:

- streams every original non-Markdown/non-CSV ZIP attachment into
  `notion-zip-attachments/`, preserving its normalized archive-relative path;
- streams every CSV original into `notion-csv-originals/`, independently of
  the Markdown table conversion;
- checks ZIP size, entry count, path containment, encryption, declared size,
  CRC-32, SHA-256, and existing-file identity before reuse;
- merges ZIP-attachment and inline-data-URL references into one manifest,
  while keeping physical entries, unique byte hashes, references, CSVs, and
  unreferenced originals as separate denominators;
- rewrites only mdast-recognized link, image, and definition destination
  spans. Labels, titles, prose, code, relations, and Docs links are not
  searched or globally replaced;
- reconstructs every changed input body byte-for-byte from the private
  manifest and retained files;
- proves every archive CSV reference was consumed by the database-table
  conversion and rejects any final destination that still resolves to one of
  the retained CSV originals. CSV source files are evidence, not members of
  the binary upload set;
- applies the production Docs codec to every stable page ID, parent, and final
  body, then enforces the advertised content limit as one batch. Any invalid
  page empties the signable event list.

The safe count/status manifest is `notion-publication-assets.json`. Archive
paths, original destinations, and page mappings live only in
`notion-publication-assets.private.json`. Prepared local-placeholder bodies,
simulated final bodies, strict preflight, and the safe status are written as:

```text
notion-publication-prepared.json
notion-publication-final.json
notion-publication-bindings.simulated.json
notion-publication-preflight.json
notion-publication-compatibility.json
notion-publication-status.json
notion-publication-report.md
```

`--simulate-bindings-origin` deterministically exercises all destination
replacement and post-binding size checks without network traffic. A simulated
binding may report `referencesBound=true`, but always keeps
`productionBindingsComplete=false`, `assetBindingsComplete=false`,
`readyForSigning=false`, and `readyToPublish=false`. Re-run the exact same
command to verify every retained file and regenerate byte-identical manifests;
an existing mismatch fails instead of overwriting the file.

## Locked execution adapters and journal

The reusable `executePublication` engine requires explicit live authorization,
an exact target relay, and an exact signer pubkey before it calls any adapter
method. `createDesktopPublicationApi()` records the existing renderer/Tauri
surface:

```text
uploadMedia -> Tauri upload_media -> kind:24242 Blossom auth -> PUT /upload
signRelayEvent -> Tauri sign_event -> current AppState signing_keys
relayClient.fetchEvents -> kinds 30623+30078, #d=doc:<pageId>
relayClient.publishEvent -> current-community NIP-42 WebSocket -> OK
fetchMediaBytes -> same-origin authenticated /media readback
```

That Desktop adapter is not a runnable host for this Node journal. The runnable
path is `createBuzzCliPublicationApi()`, which delegates to the existing Rust
Buzz client without reading or printing credentials in Node:

```text
buzz publication identity -> configured relay + public signer (no network)
buzz upload file -> Blossom kind:24242 auth -> PUT /upload
buzz media get -> Blossom get auth -> GET same-origin /media/<hash>.<ext>
buzz publication query-doc -> NIP-98 POST /query, kinds 30623+30078, #d=doc:<pageId>
buzz publication sign-doc -> BuzzClient::sign_event + optional verified NIP-OA auth tag
buzz publication publish-doc -> NIP-98 POST /events
```

`BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, and optional `BUZZ_AUTH_TAG` must already
be provisioned in the approved execution environment. They are inherited by
the child `buzz` process; the importer never reads their values and never puts
them on an argument list. Build the exact checkout first:

```bash
cargo build --release -p buzz-cli
```

Only after the coordinator separately confirms the production target, public
signer, media compatibility, and live authorization, run from `desktop/`:

```bash
node --import ./test-loader.mjs --experimental-strip-types \
  ./scripts/notion-import/cli.ts execute-publication \
  --input /private/path/notion-publication-prep/notion-publication-prepared.json \
  --assets /private/path/notion-publication-prep/notion-publication-assets.json \
  --private-assets /private/path/notion-publication-prep/notion-publication-assets.private.json \
  --compatibility /private/path/notion-publication-prep/notion-publication-compatibility.json \
  --content-limit /private/path/notion-publication-prep/notion-publication-preflight.json \
  --output /private/path/notion-publication-prep \
  --journal /private/path/notion-publication-prep/notion-publication-journal.private.json \
  --buzz-cli ../target/release/buzz \
  --target-relay wss://relay.example \
  --signer-pubkey 64-lowercase-hex-public-key \
  --authorize-live
```

Without `--authorize-live`, the command stops before reading inputs or invoking
Buzz. It also rejects a compatibility manifest whose hashes/byte denominators
do not exactly match the upload manifest, and stops before invoking Buzz when
the source set contains a relay-incompatible M4A, MOV, or SVG. Repeat the exact
same command and journal path to resume; never substitute the simulated final
JSON for `notion-publication-prepared.json`.

The executor uploads each unique source hash once, verifies descriptor bytes
by readback, binds all URLs, re-runs the full codec/limit preflight, scans all
page IDs for identical existing pages or conflicts, then re-queries immediately
before each publish. A signed event is persisted before send; relay acceptance
and signature-verified exact event readback are separate durable states. A
cross-origin descriptor is rejected before readback, and an accepted response
without valid readback is incomplete, never success.

Use `JsonPublicationJournalStore` with the same absolute journal path on every
attempt. The small top-level JSON stores the target, signer, source/corpus
hashes, preflight, and completion state. Per-asset, per-page, and full signed
event records are stored under the adjacent `.d/` directory so a 3,319-page
resume does not rewrite every signed body on each checkpoint. The store uses
an exclusive process lock, rejects a target/signer/source/corpus mismatch, and
recovers a stale lock only when its recorded process no longer exists. Resume
by repeating the exact same `executePublication(...)` call and journal path;
already-read-back assets/pages are skipped and a signed-but-ambiguous event is
re-read before the identical signed event is retried.

The Desktop adapter has two current operational constraints that must remain
on the handoff checklist: `upload_media` accepts a path already staged beneath
the OS temp directory, and `fetch_media_bytes` caps a single readback at 50
MiB. A batch containing a larger retained file cannot become complete through
this adapter until an existing bounded large-file readback seam is available.

There is no executable Node/Tauri host bridge in this importer. The
executor and journal use Node filesystem APIs, while the Desktop adapter uses
renderer-only Tauri globals. The credential-free smoke test proves the adapter
module loads in Node but `getCurrentRelay()` cannot run there; it deliberately
does not call the signer. Run it with:

```bash
node --import ./test-loader.mjs --experimental-strip-types --test \
  scripts/notion-import/desktopPublicationAdapter.test.mjs
```

`notion-publication-compatibility.json` records this Desktop-specific host gap,
the Node-compatible Buzz CLI adapter, and separate Desktop/CLI upload and
readback compatibility for every source hash. Code defaults for relay media
limits are not evidence of deployed values, and `/info` does not advertise
media upload limits. The current source set still contains relay-incompatible
M4A, MOV, and SVG files, so a runnable adapter does not make this corpus a
usable publisher: `operationalUploadReady`, `readyForSigning`, and
`readyToPublish` remain false until those assets, the target, the signer, and
production bindings are resolved and revalidated.

The converter reads one Markdown or CSV entry at a time and never extracts
attachments. It bounds archive entries and text bytes, rejects unsafe or
duplicate paths, and checks each text entry’s declared size and CRC. Files
without a trailing Notion ID get a deterministic `notion-<path hash>` ID; this
is marked as a path-derived ID rather than an original Notion ID. Parent links
come from the closest folder whose title selects exactly one page. Ambiguous
parents move to the top level and are recorded instead of being guessed.

The first non-empty H1 becomes the Docs title and is removed from the body, so
the Docs screen does not show it twice. A later H1 stays in the body and the
decoded filename supplies the title. CSV columns stay strings; this phase does
not infer Notion column types. Only columns explicitly repeated with
`--relation-column` are eligible for title-to-page relation links. `_all.csv`
files define the DB and row totals, while every CSV remains available for an
inline table. Multiline cells stay exact in the intermediate row data; the
Markdown table uses a visible `⏎` marker and reports `CSV multiline cells`
because the current Docs renderer cannot show an exact table-cell line break.

Page links become `/#/docs/<pageId>`, which matches the app’s hash router.
The current Markdown renderer has no Docs-specific in-app handler, so clicking
one is still handled as a regular external link. In-app Docs navigation is not
available in this importer-only phase.

All output files contain or derive from private source documents. Keep the
output directory outside the repository. The repository’s default
`notion-import-output/` directory, the unique inline-asset directory, and the
private data-URL manifest filename are ignored as a second line of defense.
