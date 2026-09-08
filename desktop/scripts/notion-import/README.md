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

`publish` is always a dry run. It writes unsigned inputs for the desktop
signer and never reads a key, opens a socket, or falls back to kind 30078.
Every input uses kind 30623, `d=doc:<pageId>`, `t=community-doc`, and the exact
page content shape shared with `docPageCodec.ts`. Pages above the relay’s
256 KiB content limit are listed as failures and omitted from the event list.
The publish step refreshes the JSON and Markdown reports with the unsigned
event and size-failure totals. Reports contain page IDs, byte counts, and
reason codes, never page bodies or titles.
The event JSON marks whether the batch is complete and counts valid inputs whose
direct `parentId` was rejected. `readyToPublish` remains false because these
are unsigned signer inputs. Resolve every size failure before treating the
batch as a publish plan.

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
`notion-import-output/` directory is ignored as a second line of defense.
