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
 * Relay stand-in: newest first, `until` inclusive, `limit` clamped like the
 * real thing. Records each request so tests can assert the paging shape.
 */
function fakeRelay(events, { clamp = 1_000 } = {}) {
  const sorted = [...events].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
  );
  const requests = [];
  return {
    requests,
    fetchEvents: async (filter) => {
      requests.push(filter);
      assert.deepEqual(filter.kinds, [30078]);
      assert.equal("#t" in filter, false, "kinds-only so LIMIT sees every row");
      const limit = Math.min(filter.limit, clamp);
      return sorted
        .filter((event) =>
          filter.until === undefined ? true : event.created_at <= filter.until,
        )
        .slice(0, limit);
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
  // 1200 rows in one second: `until` can never move below it.
  const events = [];
  for (let index = 0; index < 1_200; index += 1) {
    events.push(noiseEvent(index, 500));
  }
  events.push(docEvent("visible", 900), docEvent("hidden", 1));
  const relay = fakeRelay(events);
  const result = await fetchDocPagesToExhaustion({
    fetchEvents: relay.fetchEvents,
    pageLimit: 1_000,
  });
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ["visible"],
  );
  assert.equal(result.truncated, true);
  assert.ok(relay.requests.length <= 3, "gives up instead of spinning");
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
