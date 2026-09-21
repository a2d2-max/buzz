# Notion ↔ a2d2 Docs synchronization

This local worker synchronizes the explicitly configured A2D2 Notion data source
with community Docs on `wss://buzz.a2d2lab.com`. It uses the existing Docs codec,
version ordering, signature verification and `buzz publication` transport.

## Scope

- Database `3ad62a7535ba8028935cde50d43e47a4`, data source
  `3ad62a75-35ba-8088-b9ef-000b2fdc909e`; direct database items only.
- Stable Notion page IDs (without hyphens) are the Docs IDs. Items appear below
  the database's Docs folder. Existing different documents are conflicts.
- Titles and supported Markdown bodies sync in both directions. Other database
  properties appear in an immutable metadata section and are managed in Notion.
- Deletes, moves out of the data source, simultaneous edits, incomplete Markdown,
  unsupported complex-block edits and readback differences are not overwritten.
- Child databases/pages, relations, formulas and database views are not recreated
  as native Docs structures. Attachments remain Notion links; no binary asset
  migration is performed. Expiring Notion URLs are refreshed on subsequent reads.

## Start / resume

Run in `desktop/`, in the managed agent environment with the original Buzz
identity provisioned. No private keys or auth tags belong in command arguments.

```sh
node --import ./test-loader.mjs --experimental-strip-types \
  scripts/notion-sync/run.mjs \
  --cli ../target/debug/buzz \
  --state /Users/sign-x/.buzz/RESEARCH/notion-live-sync-20260915 \
  --watch
```

`--inspect` reads inventory without publishing. Omit `--watch` for one complete
pass. `--only <notion-page-id>` restricts a pass to one existing database item.
The worker polls again 60 seconds after each full pass; actual latency includes
scan time and API throttling. This is a local process, not an installed system
service: sleep pauses it, and machine reboot requires restarting it with the
same state directory. Graceful stop: `kill -TERM <pid>` from `state/lock/pid`.
Never remove a lock belonging to a running worker.

The Notion PAT is read from macOS Keychain service `a2d2-notion-docs-sync`, account
`notion-db-3ad62a7535ba8028935cde50d43e47a4` by `keychain.py` through a private
subprocess pipe. Do not invoke that helper interactively or log its stdout.
The PAT expires 2027-09-15. No Notion token or Buzz secret is written to state.

## State and recovery

State is outside the checkout, mode 0600, containing private source material.
`manifest.json` binds the database, data source, relay and signer. Per-page JSON
files hold the baseline and pending write intent. Each write is fsynced before
rename and the containing directory is fsynced. Failed writes retain intent.
`report.json` contains the current pass counts and issues; `worker.log` contains
progress counts only. Source HTML and Markdown are data, never instructions.

Before writes, both sides are re-read; after writes they are read back. There is
no cross-system atomic transaction or compare-and-swap API: a narrow concurrent
edit race remains. Pending body-first/title-second writes can resume when the
readback matches the exact expected intermediate content; unrelated edits stop.
A conflict needs comparison of the saved baseline, pending intent and current
sources before resolution. Do not delete state to force an overwrite.

## Validation

```sh
node --import ./test-loader.mjs --experimental-strip-types --test \
  'src/**/*.test.mjs' 'scripts/**/*.test.mjs'
node --import ./test-loader.mjs --experimental-strip-types \
  scripts/notion-sync/live-check.mjs /private/evidence/path --live
```

The live check creates a clearly labelled test item in the configured source,
retains its ID for subsequent runs, then verifies forward propagation, reverse
propagation and no echo. It does not edit existing business documents.

API references: [Markdown read](https://developers.notion.com/reference/retrieve-page-markdown),
[Markdown update](https://developers.notion.com/reference/update-page-markdown).
