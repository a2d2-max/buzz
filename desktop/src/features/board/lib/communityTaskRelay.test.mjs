import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { serializeCommunityTaskContent } from "./communityTaskCodec.ts";
import {
  COMMUNITY_TASK_HISTORY_MAX_PAGES,
  COMMUNITY_TASK_HISTORY_PAGE_LIMIT,
  fetchCommunityTaskEvents,
  isCommunityTaskEvent,
  publishCommunityTaskRevision,
} from "./communityTaskRelay.ts";

const AUTHOR = "a".repeat(64);

function hexId(n) {
  return n.toString(16).padStart(64, "0");
}

/** A kind:30078 row; `card` decides whether its d-tag names a card. */
function appDataEvent({ n, createdAt, card }) {
  return {
    id: hexId(n),
    pubkey: AUTHOR,
    created_at: createdAt,
    kind: 30078,
    tags: card
      ? [
          ["d", `community-task:card-${n}`],
          ["t", "community-task"],
        ]
      : [
          ["d", `read-state:${"0".repeat(32)}`],
          ["t", "read-state"],
        ],
    content: "{}",
    sig: "s".repeat(128),
  };
}

test("isCommunityTaskEvent keys on the single card d-tag only", () => {
  assert.equal(
    isCommunityTaskEvent(appDataEvent({ n: 1, createdAt: 1, card: true })),
    true,
  );
  assert.equal(
    isCommunityTaskEvent(appDataEvent({ n: 2, createdAt: 1, card: false })),
    false,
  );
  assert.equal(
    isCommunityTaskEvent({
      ...appDataEvent({ n: 3, createdAt: 1, card: true }),
      kind: 30079,
    }),
    false,
  );
});

test("history walks every kind:30078 page with the keyset cursor and keeps only cards", async (t) => {
  t.after(() => mock.reset());
  const PAGE = COMMUNITY_TASK_HISTORY_PAGE_LIMIT;
  // Page 1: a full page whose oldest rows share one created_at, so the
  // cursor must pick the largest id among them (relay order is created_at
  // DESC, id ASC — the last row is the largest id of the lowest stamp).
  const first = [];
  for (let n = 0; n < PAGE; n += 1) {
    const createdAt = n < PAGE - 3 ? 10_000 - n : 5_000;
    first.push(appDataEvent({ n: 1_000 + n, createdAt, card: n % 50 === 0 }));
  }
  // Page 2: a short page that overlaps the cursor row (relays may include it
  // when a client passes `until` without `before_id`), plus more cards.
  const second = [
    first[PAGE - 1],
    appDataEvent({ n: 7, createdAt: 4_000, card: true }),
    appDataEvent({ n: 8, createdAt: 3_000, card: false }),
    appDataEvent({ n: 9, createdAt: 2_000, card: true }),
  ];
  const filters = [];
  mock.method(relayClient, "fetchEvents", (filter) => {
    filters.push(filter);
    return Promise.resolve(filters.length === 1 ? first : second);
  });

  const cards = await fetchCommunityTaskEvents();

  assert.equal(filters.length, 2);
  assert.deepEqual(filters[0], { kinds: [30078], limit: PAGE });
  const expectedTail = first
    .filter((event) => event.created_at === 5_000)
    .map((event) => event.id)
    .sort()
    .at(-1);
  assert.deepEqual(filters[1], {
    kinds: [30078],
    limit: PAGE,
    until: 5_000,
    before_id: expectedTail,
  });
  assert.equal(
    "#t" in filters[0],
    false,
    "history never asks the relay to post-filter by t-tag",
  );
  const ids = cards.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicates across pages");
  assert.equal(cards.length, PAGE / 50 + 2);
  assert.ok(cards.every(isCommunityTaskEvent));
});

test("history stops at the page cap even when the relay never runs dry", async (t) => {
  t.after(() => mock.reset());
  let calls = 0;
  mock.method(relayClient, "fetchEvents", () => {
    calls += 1;
    const page = [];
    for (let n = 0; n < COMMUNITY_TASK_HISTORY_PAGE_LIMIT; n += 1) {
      page.push(
        appDataEvent({
          n: calls * 10_000 + n,
          createdAt: 1_000_000 - calls * 10_000 - n,
          card: false,
        }),
      );
    }
    return Promise.resolve(page);
  });
  const cards = await fetchCommunityTaskEvents();
  assert.equal(calls, COMMUNITY_TASK_HISTORY_MAX_PAGES);
  assert.deepEqual(cards, []);
});

test("history fails loudly when the relay hands the same cursor back", async (t) => {
  t.after(() => mock.reset());
  const page = [];
  for (let n = 0; n < COMMUNITY_TASK_HISTORY_PAGE_LIMIT; n += 1) {
    page.push(appDataEvent({ n, createdAt: 777, card: n === 0 }));
  }
  let calls = 0;
  mock.method(relayClient, "fetchEvents", () => {
    calls += 1;
    return Promise.resolve(page);
  });
  await assert.rejects(fetchCommunityTaskEvents(), /cursor did not advance/);
  assert.equal(calls, 2, "one page, one retry with the cursor, then stop");
});

test("publishing signs a kind:30078 card with its d and t tags and returns the event", async (t) => {
  const priorWindow = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: (command, args) => {
        assert.equal(command, "sign_event");
        return Promise.resolve(
          JSON.stringify({
            id: hexId(1),
            pubkey: AUTHOR,
            created_at: args.createdAt,
            kind: args.kind,
            tags: args.tags,
            content: args.content,
            sig: "s".repeat(128),
          }),
        );
      },
    },
  };
  const published = [];
  mock.method(relayClient, "publishEvent", (event) => {
    published.push(event);
    return Promise.resolve();
  });
  t.after(() => {
    mock.reset();
    globalThis.window = priorWindow;
  });

  const content = {
    author: AUTHOR,
    title: "Ship it",
    body: "",
    status: "todo",
    assignees: [],
    order: 1,
    createdAt: 100,
    updatedAt: 100,
  };
  const event = await publishCommunityTaskRevision({
    content,
    createdAt: 4_242,
    id: "card-1",
  });
  assert.equal(published.length, 1);
  assert.equal(published[0], event);
  assert.equal(event.kind, 30078);
  assert.equal(event.created_at, 4_242);
  assert.deepEqual(event.tags, [
    ["d", "community-task:card-1"],
    ["t", "community-task"],
  ]);
  assert.equal(event.content, serializeCommunityTaskContent(content));
});
