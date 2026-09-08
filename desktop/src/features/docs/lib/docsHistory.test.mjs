import assert from "node:assert/strict";
import test from "node:test";

import { fetchDocPagesToExhaustion } from "./docsHistory.ts";

const AUTHOR = "a".repeat(64);

function docEvent(id, createdAt, title = id) {
  return {
    id: id.padEnd(64, "0"),
    pubkey: AUTHOR,
    created_at: createdAt,
    kind: 30078,
    tags: [
      ["d", `doc:${id}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({ title, body: "", parentId: null }),
    sig: "f".repeat(128),
  };
}

/** Same kind, different `t`: the read-state traffic that crowds the window. */
function noiseEvent(index, createdAt) {
  return {
    id: `noise${index}`.padEnd(64, "0"),
    pubkey: AUTHOR,
    created_at: createdAt,
    kind: 30078,
    tags: [
      ["d", `read-state:${String(index).padStart(32, "0")}`],
      ["t", "read-state"],
    ],
    content: "ciphertext",
    sig: "f".repeat(128),
  };
}

/**
 * Relay stand-in that behaves like buzz-relay's REQ lane: newest first,
 * `since`/`until` inclusive, `limit` clamped at 1000, and — the part that
 * matters — a `#t` filter applied in memory AFTER the SQL LIMIT, so a `#t`
 * request only ever sees the newest `limit` rows of the kind. Rows that share
 * a second come back in an order the client must not rely on
 * (`rotateTies` shuffles them per request the way a real tiebreak might).
 */
function fakeRelay(events, { clamp = 1_000, rotateTies = false } = {}) {
  const sorted = [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
  );
  const requests = [];
  const rotateRuns = (rows, turn) => {
    const out = [];
    let index = 0;
    while (index < rows.length) {
      let end = index + 1;
      while (
        end < rows.length &&
        rows[end].created_at === rows[index].created_at
      ) {
        end += 1;
      }
      const run = rows.slice(index, end);
      const shift = run.length > 1 ? (turn * 37) % run.length : 0;
      out.push(...run.slice(shift), ...run.slice(0, shift));
      index = end;
    }
    return out;
  };
  return {
    requests,
    fetchEvents: async (filter) => {
      requests.push(filter);
      assert.deepEqual(filter.kinds, [30078]);
      const limit = Math.min(filter.limit, clamp);
      let rows = sorted
        .filter((event) =>
          filter.until === undefined ? true : event.created_at <= filter.until,
        )
        .filter((event) =>
          filter.since === undefined ? true : event.created_at >= filter.since,
        );
      if (rotateTies) rows = rotateRuns(rows, requests.length);
      const page = rows.slice(0, limit);
      const wantedT = filter["#t"];
      return wantedT
        ? page.filter((event) =>
            event.tags.some(
              (tag) => tag[0] === "t" && wantedT.includes(tag[1]),
            ),
          )
        : page;
    },
  };
}

test("one short page: every doc found, no truncation, one request", async () => {
  const relay = fakeRelay([
    docEvent("p1", 100),
    noiseEvent(1, 200),
    docEvent("p2", 300),
  ]);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  assert.deepEqual(result.pages.map((page) => page.id).sort(), ["p1", "p2"]);
  assert.equal(result.truncated, false);
  assert.equal(relay.requests.length, 1);
});

test("docs buried under more than a page of newer noise are still found", async () => {
  const events = [];
  for (let index = 0; index < 2_300; index += 1) {
    events.push(noiseEvent(index, 10_000 + index));
  }
  events.push(docEvent("old", 5), docEvent("older", 1));
  const relay = fakeRelay(events);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  assert.deepEqual(result.pages.map((page) => page.id).sort(), [
    "old",
    "older",
  ]);
  assert.equal(result.truncated, false);
  assert.equal(relay.requests.length, 3, "1000 + 1000 + 302 rows");
  assert.equal(relay.requests[1].until, 11_300, "cursor = oldest of page 1");
});

test("the page cap bounds the scan and reports truncation", async () => {
  const events = [];
  for (let index = 0; index < 3_500; index += 1) {
    events.push(noiseEvent(index, 10_000 + index));
  }
  events.push(docEvent("deep", 1));
  const relay = fakeRelay(events);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    maxPages: 2,
    pageLimit: 1_000,
  });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.pages, []);
  assert.equal(relay.requests.length, 2);
});

test("a full page that cannot advance the cursor is reported as truncated, not looped", async () => {
  // 1200 rows in one second: `until` can never move below it. The relay's
  // tiebreak hands back a different subset each time, so "nothing new
  // arrived" is not a stop condition the client can count on.
  const events = [];
  for (let index = 0; index < 1_200; index += 1) {
    events.push(noiseEvent(index, 500));
  }
  events.push(docEvent("visible", 900), docEvent("hidden", 1));
  const relay = fakeRelay(events, { rotateTies: true });
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ["visible"],
  );
  assert.equal(result.truncated, true);
  assert.equal(relay.requests.length, 2, "stops the moment the cursor stalls");
});

test("boundary rows re-returned by the inclusive cursor are deduplicated", async () => {
  const events = [];
  for (let index = 0; index < 1_000; index += 1) {
    events.push(noiseEvent(index, 2_000 - Math.floor(index / 10)));
  }
  events.push(docEvent("edge", 1_901), docEvent("far", 3));
  const relay = fakeRelay(events);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  const ids = result.pages.map((page) => page.id);
  assert.deepEqual([...ids].sort(), ["edge", "far"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.truncated, false);
});

test("a relay error propagates instead of masquerading as an empty wiki", async () => {
  await assert.rejects(
    fetchDocPagesToExhaustion({
      fetchEvents: async () => {
        throw new Error("relay down");
      },
      pageLimit: 1_000,
    }),
    /relay down/,
  );
});

test("since: an incremental scan asks only for rows at or after the watermark", async () => {
  const events = [];
  for (let index = 0; index < 1_500; index += 1) {
    events.push(noiseEvent(index, 10_000 + index));
  }
  events.push(docEvent("old", 5), docEvent("fresh", 11_400));
  const relay = fakeRelay(events);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
    since: 11_000,
  });
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ["fresh"],
  );
  assert.equal(result.truncated, false);
  assert.ok(relay.requests.every((request) => request.since === 11_000));
  assert.equal(relay.requests.length, 1, "500 rows fit in one page");
});

test("newestSeen is the largest created_at the scan inspected, docs or not", async () => {
  const relay = fakeRelay([
    docEvent("p1", 100),
    noiseEvent(1, 7_000),
    docEvent("p2", 300),
  ]);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  assert.equal(result.newestSeen, 7_000);
  const empty = await fetchDocPagesToExhaustion({
    fetchEvents: fakeRelay([]).fetchEvents,
    pageLimit: 1_000,
  });
  assert.equal(empty.newestSeen, undefined);
});
