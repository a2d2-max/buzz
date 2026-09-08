/**
 * Integration coverage for the write path of `useCommunityDocs`, binding the
 * production hook to stubbed relay + signer seams. The scenarios are the ones
 * review found: a save must not silently overwrite a newer version it was not
 * based on, tree operations must rebase onto the newest body, identical saves
 * must not publish, and oversized pages must be refused before signing.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const AUTHOR_ME = "a".repeat(64);
const AUTHOR_THEM = "b".repeat(64);
const PAGE_ID = "3f0c2b1a-7d4e-4c9a-9b1e-2a6f8d5c4e10";

let nextEventSerial = 0;
function signedEvent(input) {
  nextEventSerial += 1;
  return {
    id: `signed${nextEventSerial}`.padEnd(64, "0"),
    pubkey: AUTHOR_ME,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1_000),
    kind: input.kind,
    tags: input.tags,
    content: input.content,
    sig: "f".repeat(128),
  };
}

function docEvent({ id, eventId, author, createdAt, content, kind = 30623 }) {
  return {
    id: eventId.padEnd(64, "0"),
    pubkey: author,
    created_at: createdAt,
    kind,
    tags: [
      ["d", `doc:${id}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "T",
      body: "v1 body",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 2,
      ...content,
    }),
    sig: "f".repeat(128),
  };
}

const V1 = docEvent({
  id: PAGE_ID,
  eventId: "v1",
  author: AUTHOR_ME,
  createdAt: 1_000,
  content: { body: "v1 body" },
});
const V2 = docEvent({
  id: PAGE_ID,
  eventId: "v2",
  author: AUTHOR_THEM,
  createdAt: 1_100,
  content: { body: "v2 body (theirs)", title: "Theirs" },
});

before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  globalThis.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      if (command === "sign_event") {
        return Promise.resolve(JSON.stringify(signedEvent(args)));
      }
      return Promise.reject(new Error(`unmocked: ${command}`));
    },
    transformCallback: () => 1,
  };
  dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

/**
 * Mounts the hook against a relay stub; `versionsByDTag` feeds the `#d`
 * re-read, `liveEvents` are delivered by the live subscription before it
 * reports ready, and `calls` records the order of relay interactions.
 */
async function mountDocs({ history, liveEvents = [], versionsByDTag }) {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { renderHook, waitFor } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useCommunityDocs } = await import("./useCommunityDocs.ts");

  const published = [];
  const historyRequests = [];
  const calls = [];
  const reconnectListeners = [];
  const state = { versionsByDTag };
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async (filter) => {
    const dTags = filter["#d"];
    if (dTags) return state.versionsByDTag[dTags[0]] ?? [];
    historyRequests.push(filter);
    calls.push("history");
    return typeof history === "function" ? history(filter) : history;
  };
  relayClient.publishEvent = async (event) => {
    published.push(event);
  };
  relayClient.subscribeLive = async (_filter, onEvent, onReady) => {
    calls.push("subscribe");
    for (const event of liveEvents) onEvent(event);
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = (listener) => {
    reconnectListeners.push(listener);
    return () => {};
  };

  // gcTime 0: the default 5-minute garbage-collection timer would keep the
  // test process alive long after the assertions finish.
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const rendered = renderHook(() => useCommunityDocs(), { wrapper });
  await waitFor(() =>
    assert.equal(rendered.result.current.isLoading, false, "history loaded"),
  );
  return {
    calls,
    historyRequests,
    published,
    reconnectListeners,
    result: rendered.result,
    setVersions(next) {
      state.versionsByDTag = next;
    },
    restore() {
      rendered.unmount();
      client.clear();
      Object.assign(relayClient, originals);
    },
  };
}

test("a save based on an older version than the newest is refused, and the newest lands in the cache", async () => {
  const docs = await mountDocs({
    history: [V1],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventId, V1.id);
    await assert.rejects(
      docs.result.current.updatePage(
        PAGE_ID,
        { title: "mine" },
        { baseEventId: V1.id },
      ),
      (error) => error.name === "DocConflictError",
    );
    assert.equal(docs.published.length, 0, "nothing was published");
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() =>
      assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventId, V2.id),
    );
  } finally {
    docs.restore();
  }
});

test("a save based on the newest version publishes on top of it", async () => {
  const docs = await mountDocs({
    history: [V1, V2],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    const saved = await docs.result.current.updatePage(
      PAGE_ID,
      { title: "mine", body: "my body" },
      { baseEventId: V2.id },
    );
    assert.equal(docs.published.length, 1);
    const content = JSON.parse(docs.published[0].content);
    assert.equal(content.title, "mine");
    assert.equal(content.body, "my body");
    assert.ok(docs.published[0].created_at > V2.created_at);
    assert.equal(saved.title, "mine");
  } finally {
    docs.restore();
  }
});

test("a tree operation rebases onto the newest version and keeps its body", async () => {
  const docs = await mountDocs({
    history: [V1],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    await docs.result.current.updatePage(PAGE_ID, { order: 7 });
    assert.equal(docs.published.length, 1);
    const content = JSON.parse(docs.published[0].content);
    assert.equal(content.body, "v2 body (theirs)", "their body survives");
    assert.equal(content.title, "Theirs");
    assert.equal(content.order, 7);
  } finally {
    docs.restore();
  }
});

test("an identical save is not published", async () => {
  const docs = await mountDocs({
    history: [V1, V2],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    const result = await docs.result.current.updatePage(
      PAGE_ID,
      { title: "Theirs", body: "v2 body (theirs)" },
      { baseEventId: V2.id },
    );
    assert.equal(docs.published.length, 0);
    assert.equal(result.eventId, V2.id);
  } finally {
    docs.restore();
  }
});

test("an oversized page is refused before signing", async () => {
  const docs = await mountDocs({
    history: [V1, V2],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    const signedBefore = nextEventSerial;
    await assert.rejects(
      docs.result.current.updatePage(
        PAGE_ID,
        { body: "x".repeat(300 * 1024) },
        { baseEventId: V2.id },
      ),
      (error) => error.name === "DocTooLargeError",
    );
    assert.equal(docs.published.length, 0);
    assert.equal(nextEventSerial, signedBefore, "nothing was signed");
  } finally {
    docs.restore();
  }
});

test("a refetch after a complete scan is incremental, anchored on relay-stamped time", async () => {
  // The watermark must come from created_at values the relay accepted, never
  // from this machine's clock: a client running 16 minutes fast would
  // otherwise push `since` into the server's future and miss every edit.
  const newest = docEvent({
    id: "other-page",
    eventId: "newest",
    author: AUTHOR_THEM,
    createdAt: 50_000,
    content: {},
  });
  const docs = await mountDocs({
    history: [V1, newest],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1] },
  });
  try {
    assert.equal(docs.historyRequests.length, 1);
    assert.equal(
      docs.historyRequests[0].since,
      undefined,
      "first scan is full",
    );
    const realNow = Date.now;
    // A wildly wrong local clock must not move the watermark.
    Date.now = () => 9_999_999_000;
    try {
      await docs.result.current.refetch();
    } finally {
      Date.now = realNow;
    }
    assert.equal(docs.historyRequests.length, 2);
    // 50_000 − (2 × 900 + 60): two drift windows (the newest row may be
    // stamped 900 s ahead; a later event may be stamped 900 s behind).
    assert.equal(docs.historyRequests[1].since, 50_000 - 1_860);
  } finally {
    docs.restore();
  }
});

test("an incremental scan that sees nothing newer keeps the earlier watermark", async () => {
  const newest = docEvent({
    id: "other-page",
    eventId: "newest",
    author: AUTHOR_THEM,
    createdAt: 50_000,
    content: {},
  });
  const docs = await mountDocs({
    history: [V1, newest],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1] },
  });
  try {
    await docs.result.current.refetch();
    assert.equal(docs.historyRequests[1].since, 50_000 - 1_860);
    // The stub replays the same rows: the watermark must not regress.
    await docs.result.current.refetch();
    assert.equal(docs.historyRequests[2].since, 50_000 - 1_860);
  } finally {
    docs.restore();
  }
});

test("a tree operation on a page someone just deleted is refused instead of resurrecting it", async () => {
  const tombstone = docEvent({
    id: PAGE_ID,
    eventId: "v3",
    author: AUTHOR_THEM,
    createdAt: 1_200,
    content: { deleted: true },
  });
  const docs = await mountDocs({
    history: [V1],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2, tombstone] },
  });
  try {
    await assert.rejects(
      docs.result.current.movePage(PAGE_ID, null),
      /deleted/,
    );
    assert.equal(docs.published.length, 0);
  } finally {
    docs.restore();
  }
});

test("lookupPage resolves a page the history scan never delivered", async () => {
  const docs = await mountDocs({
    history: [],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    assert.equal(docs.result.current.pages.has(PAGE_ID), false);
    const found = await docs.result.current.lookupPage(PAGE_ID);
    assert.equal(found?.eventId, V2.id);
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() =>
      assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventId, V2.id),
    );
    assert.equal(await docs.result.current.lookupPage("nope"), undefined);
  } finally {
    docs.restore();
  }
});

test("the live subscription is attached before the history scan starts", async () => {
  const docs = await mountDocs({
    history: [V1],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1] },
  });
  try {
    assert.deepEqual(docs.calls.slice(0, 2), ["subscribe", "history"]);
  } finally {
    docs.restore();
  }
});

test("a version delivered live during startup survives the history merge", async () => {
  // The scan's snapshot predates v2; the live feed delivered v2 first.
  const docs = await mountDocs({
    history: [V1],
    liveEvents: [V2],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventId, V2.id);
  } finally {
    docs.restore();
  }
});

test("a relay reconnect triggers a fresh history fetch", async () => {
  const docs = await mountDocs({
    history: [V1],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1] },
  });
  try {
    assert.equal(docs.historyRequests.length, 1);
    assert.equal(docs.reconnectListeners.length, 1, "listener registered");
    const { act, waitFor } = await import("@testing-library/react");
    await act(async () => {
      for (const listener of docs.reconnectListeners) listener();
    });
    await waitFor(() => assert.equal(docs.historyRequests.length, 2));
  } finally {
    docs.restore();
  }
});

test("a page stranded on the legacy kind is republished onto the dedicated kind after a complete scan", async () => {
  // The migration copy must change nothing readers see: identical content,
  // only the event kind and created_at move.
  const legacy = docEvent({
    id: PAGE_ID,
    eventId: "legacy1",
    author: AUTHOR_THEM,
    createdAt: 1_000,
    content: { body: "legacy body", icon: "📘" },
    kind: 30078,
  });
  const docs = await mountDocs({
    history: [legacy],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [legacy] },
  });
  try {
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => assert.equal(docs.published.length, 1));
    const migrated = docs.published[0];
    assert.equal(migrated.kind, 30623);
    assert.ok(migrated.created_at > legacy.created_at);
    const content = JSON.parse(migrated.content);
    assert.equal(content.body, "legacy body");
    assert.equal(content.icon, "📘");
    assert.equal(content.updatedAt, 2, "visible timestamps are untouched");
    await waitFor(() =>
      assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventKind, 30623),
    );
  } finally {
    docs.restore();
  }
});

test("a legacy tombstone is migrated too, and stays a tombstone", async () => {
  const legacyTombstone = docEvent({
    id: PAGE_ID,
    eventId: "legacy-del",
    author: AUTHOR_THEM,
    createdAt: 1_000,
    content: { deleted: true },
    kind: 30078,
  });
  const docs = await mountDocs({
    history: [legacyTombstone],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [legacyTombstone] },
  });
  try {
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => assert.equal(docs.published.length, 1));
    assert.equal(docs.published[0].kind, 30623);
    assert.equal(JSON.parse(docs.published[0].content).deleted, true);
  } finally {
    docs.restore();
  }
});

test("migration skips a page another client already moved to the dedicated kind", async () => {
  const legacy = docEvent({
    id: PAGE_ID,
    eventId: "legacy1",
    author: AUTHOR_THEM,
    createdAt: 1_000,
    content: {},
    kind: 30078,
  });
  // The scan saw only the legacy row, but the pre-publish `#d` re-read finds
  // the dedicated-kind successor someone else published meanwhile.
  const alreadyMigrated = docEvent({
    id: PAGE_ID,
    eventId: "migrated",
    author: AUTHOR_ME,
    createdAt: 1_001,
    content: {},
  });
  const docs = await mountDocs({
    history: [legacy],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [legacy, alreadyMigrated] },
  });
  try {
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() =>
      assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventKind, 30623),
    );
    assert.equal(docs.published.length, 0, "nothing to republish");
  } finally {
    docs.restore();
  }
});

test("an identical save on top of a legacy version still publishes, migrating the page", async () => {
  // planDocPagePublish treats "identical" as a noop only on the dedicated
  // kind — otherwise an untouched page could sit on the shared 30078 window
  // forever.
  const legacyV2 = docEvent({
    id: PAGE_ID,
    eventId: "v2legacy",
    author: AUTHOR_THEM,
    createdAt: 1_100,
    content: { body: "v2 body (theirs)", title: "Theirs" },
    kind: 30078,
  });
  const docs = await mountDocs({
    history: [],
    versionsByDTag: { [`doc:${PAGE_ID}`]: [legacyV2] },
  });
  try {
    const saved = await docs.result.current.updatePage(
      PAGE_ID,
      { title: "Theirs", body: "v2 body (theirs)" },
      { baseEventId: legacyV2.id },
    );
    assert.ok(docs.published.length >= 1);
    assert.equal(docs.published[0].kind, 30623);
    assert.equal(saved.eventKind, 30623);
  } finally {
    docs.restore();
  }
});

test("a truncated scan does not start the legacy migration", async () => {
  // A truncated window may have missed the dedicated-kind successor of a
  // legacy row; migrating from it could resurrect a superseded version.
  const legacy = docEvent({
    id: PAGE_ID,
    eventId: "legacy1",
    author: AUTHOR_THEM,
    createdAt: 1_000,
    content: {},
    kind: 30078,
  });
  const busyRow = (createdAt) => ({
    id: `busy${createdAt}`.padEnd(64, "0"),
    pubkey: AUTHOR_THEM,
    created_at: createdAt,
    kind: 30078,
    tags: [
      ["d", `read-state:${String(createdAt).padStart(32, "0")}`],
      ["t", "read-state"],
    ],
    content: "x",
    sig: "f".repeat(128),
  });
  const docs = await mountDocs({
    // Every page is full and the cursor keeps moving: the scan burns its
    // whole budget and reports truncation.
    history: (filter) => {
      const top = Math.min(filter.until ?? 60_000, 60_000);
      const rows = Array.from({ length: filter.limit - 1 }, (_, index) =>
        busyRow(top - index),
      );
      return [legacy, ...rows];
    },
    versionsByDTag: { [`doc:${PAGE_ID}`]: [legacy] },
  });
  try {
    assert.equal(docs.result.current.truncated, true);
    // Give a wrongly-scheduled migration a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(docs.published.length, 0);
  } finally {
    docs.restore();
  }
});

test("an incremental scan that overflows its page budget falls back to one full scan", async () => {
  // A 31-minute window can hold more than 30 pages of read-state churn in a
  // large community. That must not end as a "pages may be missing" banner
  // plus a full rescan on the *next* load: the store retries as a full scan
  // right away, which here is short and complete.
  const newest = docEvent({
    id: "other-page",
    eventId: "newest",
    author: AUTHOR_THEM,
    createdAt: 50_000,
    content: {},
  });
  // One distinct row per second going back from 60_000: every incremental
  // page is full and the cursor keeps moving, so the scan spends its whole
  // page budget before it can reach `since`.
  const busyRow = (createdAt) => ({
    id: `busy${createdAt}`.padEnd(64, "0"),
    pubkey: AUTHOR_THEM,
    created_at: createdAt,
    kind: 30078,
    tags: [
      ["d", `read-state:${String(createdAt).padStart(32, "0")}`],
      ["t", "read-state"],
    ],
    content: "x",
    sig: "f".repeat(128),
  });
  const docs = await mountDocs({
    history: (filter) => {
      if (filter.since === undefined) return [V1, newest];
      const top = Math.min(filter.until ?? 60_000, 60_000);
      return Array.from({ length: filter.limit }, (_, index) =>
        busyRow(top - index),
      );
    },
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1] },
  });
  try {
    assert.equal(docs.result.current.truncated, false);
    await docs.result.current.refetch();
    const incremental = docs.historyRequests.filter(
      (filter) => filter.since !== undefined,
    );
    const full = docs.historyRequests.filter(
      (filter) => filter.since === undefined,
    );
    assert.equal(
      incremental.length,
      30,
      "the incremental scan ran to its budget",
    );
    assert.equal(
      full.length,
      2,
      "then one full scan, on top of the initial one",
    );
    assert.equal(docs.result.current.truncated, false, "no false alarm");
    assert.equal(docs.result.current.pages.get(PAGE_ID)?.eventId, V1.id);
    // The full scan restored a usable watermark: the next refetch starts
    // incremental again (and, with this busy stub, falls back once more).
    const before = docs.historyRequests.length;
    await docs.result.current.refetch();
    assert.notEqual(docs.historyRequests[before].since, undefined);
  } finally {
    docs.restore();
  }
});
