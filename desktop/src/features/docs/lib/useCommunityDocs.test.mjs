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

function docEvent({ id, eventId, author, createdAt, content }) {
  return {
    id: eventId.padEnd(64, "0"),
    pubkey: author,
    created_at: createdAt,
    kind: 30078,
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

/** Mounts the hook against a relay stub; `versionsByDTag` feeds the `#d` re-read. */
async function mountDocs({ history, versionsByDTag }) {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { renderHook, waitFor } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useCommunityDocs } = await import("./useCommunityDocs.ts");

  const published = [];
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
    return history;
  };
  relayClient.publishEvent = async (event) => {
    published.push(event);
  };
  relayClient.subscribeLive = async (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};

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
    published,
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
    await assert.rejects(
      docs.result.current.updatePage(
        PAGE_ID,
        { body: "x".repeat(300 * 1024) },
        { baseEventId: V2.id },
      ),
      (error) => error.name === "DocTooLargeError",
    );
    assert.equal(docs.published.length, 0);
  } finally {
    docs.restore();
  }
});
