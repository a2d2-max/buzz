import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const AUTHOR = "a".repeat(64);
let serial = 0;

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: NoopObserver,
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis) && key.startsWith("HTML")) {
      globalThis[key] = dom.window[key];
    }
  }
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  localStorage.clear();
});

after(() => dom.window.close());

function installSigner() {
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "get_relay_ws_url") return "ws://community.test";
      if (command === "get_identity") {
        return { pubkey: AUTHOR, display_name: "Author" };
      }
      if (command === "sign_event") {
        serial += 1;
        return JSON.stringify({
          id: serial.toString(16).padStart(64, "0"),
          pubkey: AUTHOR,
          created_at: args.createdAt ?? Math.floor(Date.now() / 1_000),
          kind: args.kind,
          tags: args.tags,
          content: args.content,
          sig: "f".repeat(128),
        });
      }
      throw new Error(`unmocked command: ${command}`);
    },
    transformCallback: () => 1,
  };
  dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
}

async function mountDatabases({ fetchEvents, publishEvent, subscribeLive }) {
  installSigner();
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { render } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useCommunityDatabases } = await import("./useCommunityDatabases.ts");
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = fetchEvents;
  relayClient.publishEvent = publishEvent;
  relayClient.subscribeLive = subscribeLive;
  relayClient.subscribeToReconnects = () => () => {};
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  client.setQueryData(["identity"], {
    pubkey: AUTHOR,
    displayName: "Author",
  });
  let latest;
  function Probe() {
    latest = useCommunityDatabases();
    return null;
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  return {
    get latest() {
      return latest;
    },
    async restore() {
      const { act } = await import("@testing-library/react");
      await act(async () => view.unmount());
      await new Promise((resolve) => setImmediate(resolve));
      client.clear();
      Object.assign(relayClient, originals);
    },
  };
}

test("both live subscriptions are ready before history and a live row survives the merge", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const { serializeDatabaseRowContent } = await import("./databaseRowCodec.ts");
  const order = [];
  const live = new Map();
  const historyReleases = [];
  const mounted = await mountDatabases({
    fetchEvents: (filter) => {
      order.push(`history:${filter.kinds[0]}`);
      return new Promise((resolve) => historyReleases.push(() => resolve([])));
    },
    publishEvent: async () => {},
    subscribeLive: async (filter, onEvent, onReady) => {
      const tag = filter["#t"][0];
      order.push(`live:${tag}`);
      live.set(tag, onEvent);
      onReady("eose");
      return async () => {};
    },
  });
  try {
    await waitFor(() => assert.equal(historyReleases.length, 2));
    assert.deepEqual(order.slice(0, 2).sort(), [
      "live:community-db",
      "live:community-db-row",
    ]);
    const rowId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await act(async () => {
      live.get("community-db-row")({
        id: "e".repeat(64),
        pubkey: AUTHOR,
        created_at: 10,
        kind: 30625,
        tags: [
          ["d", `dbrow:${rowId}`],
          ["t", "community-db-row"],
          ["db", "11111111-2222-4333-8444-555555555555"],
        ],
        content: serializeDatabaseRowContent({
          values: { title: "Live" },
          docPageId: null,
          createdBy: AUTHOR,
          createdAt: 1,
          updatedAt: 1,
        }),
        sig: "f".repeat(128),
      });
      for (const release of historyReleases) release();
    });
    await waitFor(() =>
      assert.equal(mounted.latest.rows.get(rowId)?.values.title, "Live"),
    );
  } finally {
    await mounted.restore();
  }
});

test("schema fallback stays independent while row edits publish recoverable full snapshots", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const stored = [];
  const attempts = [];
  let failNextRow = false;
  const mounted = await mountDatabases({
    fetchEvents: async (filter) => {
      const dTag = filter["#d"]?.[0];
      if (!dTag) return [];
      return stored.filter((event) =>
        event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag),
      );
    },
    publishEvent: async (event) => {
      attempts.push(event);
      if (event.kind === 30624) {
        throw new Error("restricted: unknown event kind");
      }
      if (event.kind === 30625 && failNextRow) {
        failNextRow = false;
        throw new Error("relay offline");
      }
      stored.push(event);
    },
    subscribeLive: async (_filter, _onEvent, onReady) => {
      onReady("eose");
      return async () => {};
    },
  });
  try {
    await waitFor(() => assert.equal(mounted.latest.isLoading, false));
    let database;
    await act(async () => {
      database = await mounted.latest.createDatabase("Work");
    });
    assert.deepEqual(
      attempts.slice(0, 2).map((event) => event.kind),
      [30624, 30078],
    );
    let row;
    await act(async () => {
      row = await mounted.latest.createRow(database.id);
    });
    assert.equal(row.createdBy, AUTHOR);
    assert.equal(attempts.at(-1).kind, 30625);

    failNextRow = true;
    await act(async () => {
      await assert.rejects(
        mounted.latest.updateRowValues(
          row.id,
          { ...row.values, title: "Draft", untouched: "kept" },
          row.eventId,
        ),
        /relay offline/,
      );
    });
    await waitFor(() =>
      assert.equal(mounted.latest.rows.get(row.id)?.values.title, ""),
    );
    const failedContent = JSON.parse(attempts.at(-1).content);
    assert.deepEqual(failedContent.values, {
      title: "Draft",
      untouched: "kept",
    });
    assert.equal(failedContent.createdBy, AUTHOR);

    await act(async () => {
      row = await mounted.latest.updateRowValues(
        row.id,
        failedContent.values,
        row.eventId,
      );
    });
    assert.equal(row.values.title, "Draft");
    await waitFor(() =>
      assert.equal(mounted.latest.rows.get(row.id)?.values.untouched, "kept"),
    );
  } finally {
    await mounted.restore();
  }
});

test("a pre-write row lookup rejects a stale base and folds the newer head into cache", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const stored = [];
  const queries = [];
  const mounted = await mountDatabases({
    fetchEvents: async (filter) => {
      queries.push(filter);
      const dTag = filter["#d"]?.[0];
      return dTag
        ? stored.filter((event) =>
            event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag),
          )
        : [];
    },
    publishEvent: async (event) => stored.push(event),
    subscribeLive: async (_filter, _onEvent, onReady) => {
      onReady("eose");
      return async () => {};
    },
  });
  try {
    await waitFor(() => assert.equal(mounted.latest.isLoading, false));
    let database;
    let row;
    await act(async () => {
      database = await mounted.latest.createDatabase("Work");
      row = await mounted.latest.createRow(database.id);
    });
    const newer = {
      ...stored.at(-1),
      id: "f".repeat(64),
      pubkey: "b".repeat(64),
      created_at: stored.at(-1).created_at + 1,
      content: JSON.stringify({
        ...JSON.parse(stored.at(-1).content),
        values: { title: "Theirs" },
      }),
    };
    stored.push(newer);
    await act(async () => {
      await assert.rejects(
        mounted.latest.updateRowValues(row.id, { title: "Mine" }, row.eventId),
        (error) => error.name === "DatabaseConflictError",
      );
    });
    await waitFor(() =>
      assert.equal(mounted.latest.rows.get(row.id)?.values.title, "Theirs"),
    );
    let lookedUp;
    await act(async () => {
      lookedUp = await mounted.latest.lookupRow(row.id);
    });
    assert.equal(lookedUp?.id, row.id);
    assert.deepEqual(queries.at(-1)["#d"], [`dbrow:${row.id}`]);
    assert.deepEqual(queries.at(-1).kinds, [30625, 30078]);
    assert.equal(mounted.latest.rowHistoryComplete, true);
  } finally {
    await mounted.restore();
  }
});
