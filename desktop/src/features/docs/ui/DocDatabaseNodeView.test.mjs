import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const AUTHOR = "a".repeat(64);
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let serial = 10;

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

before(() => {
  const zeroRect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
  dom.window.Range.prototype.getBoundingClientRect = () => zeroRect;
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ClipboardEvent: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    requestAnimationFrame: (callback) =>
      setTimeout(() => callback(Date.now()), 0),
    ResizeObserver: NoopObserver,
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        ["Element", "MouseEvent", "KeyboardEvent", "FocusEvent"].includes(key))
    ) {
      const value = dom.window[key];
      if (value !== undefined) globalThis[key] = value;
    }
  }
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  dom.window.localStorage.clear();
});

after(() => dom.window.close());

function schemaEvent() {
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_000,
    kind: 30624,
    tags: [
      ["d", `db:${DATABASE_ID}`],
      ["t", "community-db"],
    ],
    content: JSON.stringify({
      name: "Launch plan",
      properties: [
        { id: "title", name: "Name", type: "title" },
        { id: "notes", name: "Notes", type: "text" },
      ],
      views: [
        {
          id: "table",
          name: "Table",
          type: "table",
          sorts: [],
          visiblePropertyIds: ["title", "notes"],
          propertyWidths: { title: 240, notes: 240 },
        },
        {
          id: "gallery",
          name: "Gallery",
          type: "gallery",
          sorts: [],
          visiblePropertyIds: ["title", "notes"],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
    }),
    sig: "f".repeat(128),
  };
}

function rowEvent() {
  return {
    id: "2".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_001,
    kind: 30625,
    tags: [
      ["d", `dbrow:${ROW_ID}`],
      ["t", "community-db-row"],
      ["db", DATABASE_ID],
    ],
    content: JSON.stringify({
      values: { title: "Original", notes: "Keep me" },
      docPageId: null,
      createdBy: AUTHOR,
      createdAt: 1,
      updatedAt: 2,
    }),
    sig: "f".repeat(128),
  };
}

test("database node owns database events while view selection and removal own Docs saves", async () => {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { act, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  );
  const { relayClient } = await import("@/shared/api/relayClient");
  const { CommunityDatabasesProvider } = await import(
    "@/features/databases/ui/CommunityDatabasesProvider"
  );
  const { DocPageEditor } = await import("./DocPageEditor.tsx");

  const schemas = [schemaEvent()];
  const rows = [rowEvent()];
  const published = [];
  const docsSaves = [];
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async (filter) => {
    if (filter["#d"]?.[0]?.startsWith("dbrow:")) return rows;
    if (filter["#d"]?.[0]?.startsWith("db:")) return schemas;
    return filter.kinds.includes(30625) ? rows : schemas;
  };
  relayClient.publishEvent = async (event) => {
    published.push(event);
    if (event.kind === 30625) rows.splice(0, rows.length, event);
    if (event.kind === 30624) schemas.splice(0, schemas.length, event);
  };
  relayClient.subscribeLive = async (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
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

  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  client.setQueryData(["identity"], {
    pubkey: AUTHOR,
    displayName: "Author",
  });
  const editorRef = React.createRef();
  const directive = `:::db ${DATABASE_ID} table`;
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        CommunityDatabasesProvider,
        null,
        React.createElement(DocPageEditor, {
          onAutosaveState: () => {},
          onSave: async (draft) => docsSaves.push(draft),
          page: {
            author: AUTHOR,
            body: `Before\n\n${directive}\n\nAfter`,
            createdAt: 1,
            deleted: false,
            eventCreatedAt: 1,
            eventId: "e".repeat(64),
            id: "page-with-database",
            order: 0,
            parentId: null,
            title: "Plan",
            updatedAt: 1,
          },
          ref: editorRef,
        }),
      ),
    ),
  );

  try {
    const cell = await waitFor(() =>
      view.getByTestId(`database-cell-${ROW_ID}-title`),
    );
    fireEvent.click(cell);
    const input = view.getByLabelText("Edit Name");
    fireEvent.change(input, { target: { value: "Ready" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => assert.equal(published.length, 1));
    assert.equal(published[0].kind, 30625);
    assert.deepEqual(JSON.parse(published[0].content).values, {
      title: "Ready",
      notes: "Keep me",
    });
    await act(async () => assert.equal(await editorRef.current.flush(), true));
    assert.equal(docsSaves.length, 0);

    fireEvent.click(view.getByRole("tab", { name: "Gallery" }));
    await act(async () => assert.equal(await editorRef.current.flush(), true));
    assert.equal(docsSaves.length, 1);
    assert.match(docsSaves[0].body, new RegExp(`:::db ${DATABASE_ID} gallery`));
    assert.match(docsSaves[0].body, /^Before/m);
    assert.match(docsSaves[0].body, /^After/m);
    assert.equal(published.length, 1);

    fireEvent.click(view.getByRole("button", { name: "Remove block" }));
    await act(async () => assert.equal(await editorRef.current.flush(), true));
    assert.equal(docsSaves.length, 2);
    assert.doesNotMatch(docsSaves[1].body, /:::db/);
    assert.match(docsSaves[1].body, /^Before/m);
    assert.match(docsSaves[1].body, /^After/m);
    assert.equal(published.length, 1);
  } finally {
    view.unmount();
    client.clear();
    Object.assign(relayClient, originals);
  }
});

test("missing and failed exact database lookups settle into retryable UI", async () => {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { render, waitFor } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { CommunityDatabasesProvider } = await import(
    "@/features/databases/ui/CommunityDatabasesProvider"
  );
  const { DocDatabaseBlock } = await import("./DocDatabaseBlock.tsx");
  const missingId = "33333333-3333-4333-8333-333333333333";
  const failedId = "44444444-4444-4444-8444-444444444444";
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async (filter) => {
    if (filter["#d"]?.[0] === `db:${failedId}`) {
      throw new Error("relay unavailable");
    }
    return [];
  };
  relayClient.subscribeLive = async (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === "get_relay_ws_url") return "ws://community.test";
      if (command === "get_identity") {
        return { pubkey: AUTHOR, display_name: "Author" };
      }
      throw new Error(`unmocked command: ${command}`);
    },
    transformCallback: () => 1,
  };
  dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  client.setQueryData(["identity"], {
    pubkey: AUTHOR,
    displayName: "Author",
  });
  const block = (databaseId) =>
    React.createElement(DocDatabaseBlock, {
      databaseId,
      key: databaseId,
      onSelectView: () => {},
      viewId: null,
    });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        CommunityDatabasesProvider,
        null,
        block(missingId),
        block(failedId),
      ),
    ),
  );
  try {
    await waitFor(() => {
      assert.match(
        view.getByTestId(`doc-database-${missingId}`).textContent,
        /missing or was deleted/,
      );
      assert.match(
        view.getByTestId(`doc-database-${failedId}`).textContent,
        /Couldn't check the relay/,
      );
    });
    assert.equal(view.queryAllByTestId("buzz-loading-state").length, 0);
    assert.equal(view.getAllByRole("button", { name: "Retry" }).length, 2);
  } finally {
    view.unmount();
    client.clear();
    Object.assign(relayClient, originals);
  }
});
