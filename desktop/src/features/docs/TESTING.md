# Docs — testing

## Unit and screen tests (run in CI)

```bash
just desktop-test          # whole desktop suite
cd desktop && node --import ./test-loader.mjs --experimental-strip-types \
  --test "src/features/docs/**/*.test.mjs"
```

- `lib/docPageCodec.test.mjs`, `lib/docTree.test.mjs` — event codec, tree
  building (tombstones, orphans, cycles), version ordering, sibling reorder.
- `lib/docsHistory.test.mjs` — the kinds-only `until` cursor scan against a
  fake relay that, like buzz-relay, applies `#t` *after* the SQL `LIMIT`.
  Re-adding `#t` to the request reproduces the starvation and fails 4 tests.
- `lib/docPublishPlan.test.mjs`, `lib/useCommunityDocs.test.mjs` — the write
  path: `#d` re-read before every publish, conflict on a stale
  `baseEventId`, no-op for identical content, 256 KB refusal before signing,
  subscription-before-scan ordering, reconnect refetch, incremental
  watermark anchored on relay-stamped `created_at`.
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

### 2. Protocol probe — `scripts/docs-relay-probe.mjs`

Runs `fetchDocPagesToExhaustion` and the codec over a raw NIP-42 WebSocket
client. Publishes 3 pages, then 1100 newer kind-30078 rows spread over 25
identities (the per-user write budget), then checks:

```bash
cd desktop && RELAY_URL=ws://localhost:3100 node --import ./test-loader.mjs \
  --experimental-strip-types scripts/docs-relay-probe.mjs
```

Expected (recorded 2026-09-08 against `target/debug/buzz-relay` built from
`571c1902d`):

```
PASS  #t-filtered REQ starves behind >1000 newer rows (the bug)  — returned 0/3 pages
PASS  kinds-only REQ returns exactly the 1000-row window  — 1000 rows
PASS  paged kinds-only scan finds every page  — 3 pages, 2 REQs, scanned 1103 rows, truncated=false
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
