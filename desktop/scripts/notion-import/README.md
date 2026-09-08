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
```

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
value, source, and whether an advertisement was verified.

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
again. The current operational relay advertisement has not been confirmed by
this tool; local test advertisements are recorded with
`operationalAdvertisementConfirmed=false`.

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
