# Docs — testing

## Unit and screen tests (run in CI)

```bash
just desktop-test          # whole desktop suite
cd desktop && node --import ./test-loader.mjs --experimental-strip-types \
  --test "src/features/docs/**/*.test.mjs"
```

- `lib/docPageCodec.test.mjs`, `lib/docTree.test.mjs` — event codec, tree
  building (tombstones, orphans, cycles), version ordering, sibling reorder.
  Writes go to the dedicated kind 30623; the codec still parses legacy
  kind-30078 pages and records provenance in `eventKind`.
- `lib/docsHistory.test.mjs` — the kinds-only `until` cursor scan (over
  30623 + legacy 30078) against a fake relay that, like buzz-relay, applies
  `#t` *after* the SQL `LIMIT`. Re-adding `#t` to the request reproduces the
  starvation and fails 4 tests; dropping the legacy kind fails the
  legacy-coverage test.
- `lib/docPublishPlan.test.mjs`, `lib/useCommunityDocs.test.mjs` — the write
  path: `#d` re-read before every publish, conflict on a stale
  `baseEventId`, no-op for identical content (dedicated-kind versions only —
  an identical write on a legacy version still publishes, migrating the
  page), 256 KB refusal before signing, subscription-before-scan ordering,
  reconnect refetch, incremental watermark anchored on relay-stamped
  `created_at`, and the one-shot legacy migration: after a complete scan,
  pages stranded on 30078 are republished verbatim onto 30623 (tombstones
  included), skipped when a dedicated-kind successor exists, and never run
  from a truncated scan.
- `lib/autosaveScheduler.test.mjs`, `lib/docDraftBackup.test.mjs`,
  `lib/markdownFidelity.test.mjs`, `lib/docEditorMarkdown.test.mjs` —
  debounce/flush/pause semantics, localStorage draft mirror, the
  rich-editor fidelity check, and markdown round trips through the real
  `useRichTextEditor` in document mode.
- `ui/DocsScreen.test.mjs`, `ui/DocPageEditor.test.mjs` — the real screen
  and editor in jsdom over a stubbed relay: a save based on an older
  version is refused and only "Keep mine" publishes; table pages open as
  markdown source; failed saves leave a recoverable draft.

Every guard above was checked by mutation: removing it makes at least one
test fail.

## Runtime verification against a real relay (manual)

The history scan and conflict handling rest on relay behaviour that unit
tests can only imitate (`#t` is filtered after `LIMIT`, `#d` is pushed down
for NIP-33 kinds, `limit` is clamped at 1000, `until`/`since` are
inclusive). Two scripts exercise the production code against a live
buzz-relay. They publish throwaway data, so run them against a throwaway
relay, never a shared one.

### 1. Throwaway relay without Docker

Postgres and Redis from Homebrew, isolated under a scratch directory, and
the relay binary from `cargo build -p buzz-relay` (or an existing
`target/debug/buzz-relay`):

```bash
LAB=$(mktemp -d)
PG=/opt/homebrew/opt/postgresql@15/bin
$PG/initdb -D "$LAB/pg" -U postgres --auth=trust -E UTF8
# unix_socket_directories='' — the scratch path is too long for a socket.
$PG/pg_ctl -D "$LAB/pg" -o "-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -l "$LAB/pg.log" start
$PG/createdb -h 127.0.0.1 -p 5433 -U postgres buzz
redis-server --port 6380 --dir "$LAB" --daemonize yes --save "" --appendonly no

DATABASE_URL=postgres://postgres@127.0.0.1:5433/buzz REDIS_URL=redis://127.0.0.1:6380 \
BUZZ_BIND_ADDR=127.0.0.1:3100 RELAY_URL=ws://localhost:3100 \
BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32) BUZZ_AUTO_MIGRATE=true \
BUZZ_GIT_CONFORMANCE_PROBE=false BUZZ_PUSH_ENABLED=false \
  ./target/debug/buzz-relay &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/health   # 200

# Community hosts for ws://localhost:3100 (the relay is tenant-by-host).
PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGDATABASE=buzz \
  RELAY_URL=ws://localhost:3100 ./scripts/seed-local-community.sh
```

`BUZZ_AUTO_MIGRATE=true` applies the embedded migrations on startup;
`BUZZ_GIT_CONFORMANCE_PROBE=false` skips the S3-backed git probe (no MinIO
in this setup). Tear down with `pg_ctl stop`, `redis-cli -p 6380 shutdown`
and by removing `$LAB`.

A relay binary that predates the dedicated kind rejects kind 30623 at
ingest (`restricted: unknown event kind`), so the probe cannot run against
an old binary at all — build from the checkout under test. If the binary is
merely a few commits behind, first confirm the four relay properties the
scan depends on are unchanged at HEAD — a green run against an old binary
proves nothing about a relay that changed them:

```bash
# 1. Neither doc kind (30623, legacy 30078) sits in a post-filter gate list.
#    (`community_doc_sits_in_no_read_gate` in kind.rs pins 30623 in CI.)
grep -n -A6 -E 'pub const (AUTHOR_ONLY|P_GATED|RESULT_GATED|SHARED_GATED)_KINDS' crates/buzz-core/src/kind.rs
# 2. `#t` is still not pushed down to SQL (only d/e tags are).
grep -n -E 'pub (d_tags|e_tags|t_tags):' crates/buzz-db/src/store/event.rs
# 3. The REQ lane still post-filters after LIMIT (filters_match / event_visible_to_reader).
grep -n -E 'filters_match\(std::slice|event_visible_to_reader|accessible_channels.contains' crates/buzz-relay/src/handlers/req.rs
# 4. The page clamp and ordering are unchanged.
grep -n -E 'DEFAULT_MAX_PAGE_LIMIT: i64|created_at DESC, id ASC' crates/buzz-db/src/store/event.rs
```

### 2. Protocol probe — `scripts/docs-relay-probe.mjs`

Runs `fetchDocPagesToExhaustion` and the codec over a raw NIP-42 WebSocket
client. Publishes 3 pages on the dedicated kind (30623) plus 1 page on the
legacy kind (30078), then 1100 newer kind-30078 rows spread over 25
identities (the per-user write budget), then checks:

```bash
cd desktop && RELAY_URL=ws://localhost:3100 node --import ./test-loader.mjs \
  --experimental-strip-types scripts/docs-relay-probe.mjs
```

Expected (recorded 2026-09-08 against `target/debug/buzz-relay` built from
this branch — the relay must know kind 30623, so build it from the checkout
under test):

```
PASS  relay accepts and stores the dedicated doc kind  — kind 30623
PASS  #t-filtered REQ on legacy 30078 starves behind >1000 newer rows (the bug)  — returned 0/1 legacy pages
PASS  kinds-only REQ returns exactly the 1000-row window  — 1000 rows
PASS  dedicated-kind REQ window holds only doc pages, noise cannot starve it  — 3/3 rows are docs
PASS  paged scan over both kinds finds every page, legacy included  — 4 pages, 2 REQs, scanned 1104 rows, truncated=false
PASS  #d lookup returns every author's version and resolves the newest  — 2 versions
PASS  incremental scan (since = newestSeen − 1860) sees the pages and B's version  — 2 REQs
PASS  live #t subscription delivers another author's new page
```

### 3. Live screen — `scripts/docs-relay-live.mjs`

Mounts the production `DocsScreen` (real hook, real `relayClient`) in
jsdom. Only the Tauri shell is stood in for: the websocket plugin is
bridged to Node's `WebSocket`, and identity/signing use a throwaway key. A
second raw client plays "someone else".

```bash
cd desktop && RELAY_URL=ws://localhost:3100 node --import ./test-loader.mjs \
  --experimental-strip-types scripts/docs-relay-live.mjs
```

Expected (same run):

```
PASS  S4a table page opens as markdown source with the lossy notice
PASS  S4b the edit reached the relay with the table intact
PASS  S2a stale save is refused: relay still holds Bob's version, banner shown
PASS  S2b 'Keep mine' publishes Alice's draft on top of Bob's version
PASS  S3 a page published during a socket drop appears after the reconnect  — sockets opened: 2
```

The `act(...)` warnings React prints during the run are noise from driving
the real screen outside a test runner.
