import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
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
    self: dom.window,
    window: dom.window,
  });
});
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  localStorage.clear();
});
after(() => dom.window.close());

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const AUTHOR = "a".repeat(64);

function formulaSchemaEvent() {
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1,
    kind: 30624,
    tags: [
      ["d", `db:${DATABASE_ID}`],
      ["t", "community-db"],
    ],
    content: JSON.stringify({
      name: "Clock",
      properties: [
        { id: "title", name: "Name", type: "title" },
        {
          id: "today",
          name: "Today",
          type: "formula",
          options: { expression: "today()", resultType: "date" },
        },
      ],
      views: [
        {
          id: "table",
          name: "Table",
          type: "table",
          sorts: [],
          visiblePropertyIds: ["title", "today"],
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    }),
    sig: "f".repeat(128),
  };
}

test("two consumers share one hook subscription history reconnect and formula clock", async () => {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { render, waitFor } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { CommunityDatabasesProvider, useCommunityDatabasesContext } =
    await import("./CommunityDatabasesProvider.tsx");
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === "get_identity") {
        return { pubkey: AUTHOR, display_name: "Author" };
      }
      if (command === "get_relay_ws_url") return "ws://community.test";
      throw new Error(`unmocked command: ${command}`);
    },
    transformCallback: () => 1,
  };
  window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
  };
  let fetches = 0;
  let subscriptions = 0;
  let stopped = 0;
  let reconnects = 0;
  let reconnectStops = 0;
  let intervals = 0;
  let clearedIntervals = 0;
  relayClient.fetchEvents = async () => {
    fetches += 1;
    return [];
  };
  relayClient.subscribeLive = async (filter, onEvent, onReady) => {
    subscriptions += 1;
    if (filter["#t"]?.[0] === "community-db") onEvent(formulaSchemaEvent());
    onReady?.();
    return async () => {
      stopped += 1;
    };
  };
  relayClient.subscribeToReconnects = () => {
    reconnects += 1;
    return () => {
      reconnectStops += 1;
    };
  };
  window.setInterval = () => {
    intervals += 1;
    return 77;
  };
  window.clearInterval = (id) => {
    if (id === 77) clearedIntervals += 1;
  };
  const values = [];
  function Probe() {
    values.push(useCommunityDatabasesContext());
    return null;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  client.setQueryData(["identity"], {
    pubkey: AUTHOR,
    displayName: "Author",
  });
  const providerTree = () =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        CommunityDatabasesProvider,
        null,
        React.createElement(Probe),
        React.createElement(Probe),
      ),
    );
  const view = render(providerTree());
  let remounted = null;
  try {
    await waitFor(() => {
      assert.equal(subscriptions, 2);
      assert.equal(fetches, 2);
      assert.equal(intervals, 1);
      assert.equal(values.at(-1).schemas.has(DATABASE_ID), true);
    });
    assert.equal(reconnects, 1);
    assert.equal(values.at(-1).resolveValue, values.at(-2).resolveValue);
    view.unmount();
    await waitFor(() => {
      assert.equal(stopped, 2);
      assert.equal(reconnectStops, 1);
      assert.equal(clearedIntervals, 1);
    });
    client.removeQueries({ queryKey: ["databases", "community"] });
    remounted = render(providerTree());
    await waitFor(() => {
      assert.equal(subscriptions, 4);
      assert.equal(fetches, 4);
      assert.equal(reconnects, 2);
      assert.equal(intervals, 2);
    });
    remounted.unmount();
    await waitFor(() => {
      assert.equal(stopped, 4);
      assert.equal(reconnectStops, 2);
      assert.equal(clearedIntervals, 2);
    });
  } finally {
    remounted?.unmount();
    relayClient.fetchEvents = originals.fetchEvents;
    relayClient.subscribeLive = originals.subscribeLive;
    relayClient.subscribeToReconnects = originals.subscribeToReconnects;
    window.setInterval = originals.setInterval;
    window.clearInterval = originals.clearInterval;
    client.clear();
  }
});
