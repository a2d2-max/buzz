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
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
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
        [
          "Element",
          "Node",
          "Event",
          "MouseEvent",
          "KeyboardEvent",
          "FocusEvent",
        ].includes(key))
    ) {
      const value = dom.window[key];
      if (value !== undefined) globalThis[key] = value;
    }
  }
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  localStorage.clear();
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

async function mountScreen({
  schemaEvents = [schemaEvent()],
  rowEvents = [rowEvent()],
  viewId,
} = {}) {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    RouterContextProvider,
    createMemoryHistory,
    createRootRoute,
    createRouter,
  } = await import("@tanstack/react-router");
  const { render } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { DatabasesScreen } = await import("./DatabasesScreen.tsx");
  const schemas = [...schemaEvents];
  const rows = [...rowEvents];
  const published = [];
  const exactReads = [];
  let nextPublishError = null;
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async (filter) => {
    if (filter["#d"]) {
      exactReads.push(filter);
      return filter["#d"][0].startsWith("dbrow:") ? rows : schemas;
    }
    return filter.kinds.includes(30625) ? rows : schemas;
  };
  relayClient.publishEvent = async (event) => {
    if (nextPublishError) {
      const error = nextPublishError;
      nextPublishError = null;
      throw new Error(error);
    }
    published.push(event);
    if (event.kind === 30624) schemas.splice(0, schemas.length, event);
    if (event.kind === 30625) rows.splice(0, rows.length, event);
  };
  relayClient.subscribeLive = async (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};

  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "get_relay_ws_url") return "ws://community.test";
      if (command === "get_identity")
        return { pubkey: AUTHOR, display_name: "Author" };
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
  client.setQueryData(["identity"], { pubkey: AUTHOR, displayName: "Author" });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({
      initialEntries: [`/databases/${DATABASE_ID}`],
    }),
  });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        RouterContextProvider,
        { router },
        React.createElement(DatabasesScreen, {
          databaseId: DATABASE_ID,
          viewId,
        }),
      ),
    ),
  );
  return {
    exactReads,
    published,
    view,
    failNextPublish(message) {
      nextPublishError = message;
    },
    replaceRow(event) {
      rows.splice(0, rows.length, event);
    },
    replaceSchema(event) {
      schemas.splice(0, schemas.length, event);
    },
    async restore() {
      const { act } = await import("@testing-library/react");
      await act(async () => view.unmount());
      client.clear();
      Object.assign(relayClient, originals);
    },
  };
}

test("a table edit reaches the real hook as one full-row signed snapshot", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const mounted = await mountScreen();
  try {
    const cell = await waitFor(() =>
      mounted.view.getByTestId(`database-cell-${ROW_ID}-title`),
    );
    fireEvent.click(cell);
    const input = mounted.view.getByLabelText("Edit Name");
    fireEvent.change(input, { target: { value: "Ready" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => assert.equal(mounted.published.length, 1));
    const published = mounted.published[0];
    assert.equal(published.kind, 30625);
    assert.deepEqual(JSON.parse(published.content).values, {
      title: "Ready",
      notes: "Keep me",
    });
    assert.ok(
      mounted.exactReads.some(
        (filter) => filter["#d"]?.[0] === `dbrow:${ROW_ID}`,
      ),
      "the hook must re-read the exact row coordinate before publishing",
    );
  } finally {
    await mounted.restore();
  }
});

test("a stale screen draft reloads the exact row and preserves remote cells on retry", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const mounted = await mountScreen();
  try {
    const cell = await waitFor(() =>
      mounted.view.getByTestId(`database-cell-${ROW_ID}-title`),
    );
    fireEvent.click(cell);
    const input = mounted.view.getByLabelText("Edit Name");
    fireEvent.change(input, { target: { value: "Mine" } });
    mounted.replaceRow({
      ...rowEvent(),
      id: "8".repeat(64),
      created_at: 1_100,
      content: JSON.stringify({
        values: { title: "Theirs", notes: "Remote" },
        docPageId: null,
        createdBy: AUTHOR,
        createdAt: 1,
        updatedAt: 3,
      }),
    });
    fireEvent.keyDown(input, { key: "Enter" });
    const retry = await mounted.view.findByRole("button", {
      name: "Retry Name",
    });
    assert.equal(mounted.published.length, 0);
    await waitFor(() =>
      assert.match(
        mounted.view.getByRole("alert").textContent,
        /newer row was loaded/i,
      ),
    );
    fireEvent.click(retry);
    await waitFor(() => assert.equal(mounted.published.length, 1));
    assert.deepEqual(JSON.parse(mounted.published[0].content).values, {
      title: "Mine",
      notes: "Remote",
    });
  } finally {
    await mounted.restore();
  }
});

test("a relay publish failure keeps the screen draft until retry succeeds", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const mounted = await mountScreen();
  try {
    const cell = await waitFor(() =>
      mounted.view.getByTestId(`database-cell-${ROW_ID}-title`),
    );
    fireEvent.click(cell);
    const input = mounted.view.getByLabelText("Edit Name");
    fireEvent.change(input, { target: { value: "Retry me" } });
    mounted.failNextPublish("relay offline");
    fireEvent.keyDown(input, { key: "Enter" });
    const retry = await mounted.view.findByRole("button", {
      name: "Retry Name",
    });
    assert.equal(mounted.view.getByLabelText("Edit Name").value, "Retry me");
    assert.equal(mounted.published.length, 0);
    fireEvent.click(retry);
    await waitFor(() => assert.equal(mounted.published.length, 1));
    assert.equal(
      JSON.parse(mounted.published[0].content).values.title,
      "Retry me",
    );
  } finally {
    await mounted.restore();
  }
});

test("a stale database name keeps its draft and rebases onto concurrent schema changes", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const mounted = await mountScreen();
  try {
    const name = await mounted.view.findByLabelText("Database name");
    fireEvent.change(name, { target: { value: "My launch plan" } });
    const concurrent = {
      ...schemaEvent(),
      id: "8".repeat(64),
      created_at: 1_100,
      content: JSON.stringify({
        ...JSON.parse(schemaEvent().content),
        name: "Remote launch plan",
        properties: [
          { id: "title", name: "Name", type: "title" },
          { id: "notes", name: "Remote notes", type: "text" },
        ],
        updatedAt: 3,
      }),
    };
    mounted.replaceSchema(concurrent);
    fireEvent.keyDown(name, { key: "Enter" });

    const retry = await mounted.view.findByRole("button", {
      name: "Retry database name",
    });
    assert.equal(
      mounted.view.getByLabelText("Database name").value,
      "My launch plan",
    );
    assert.equal(mounted.published.length, 0);
    assert.match(mounted.view.getByRole("alert").textContent, /newer/i);
    fireEvent.click(retry);
    await waitFor(() => assert.equal(mounted.published.length, 1));
    const content = JSON.parse(mounted.published[0].content);
    assert.equal(content.name, "My launch plan");
    assert.equal(
      content.properties.find((property) => property.id === "notes").name,
      "Remote notes",
    );
  } finally {
    await mounted.restore();
  }
});

test("clearing a select through the real screen signs null in the full row", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const typedSchema = schemaEvent();
  typedSchema.content = JSON.stringify({
    ...JSON.parse(typedSchema.content),
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "priority",
        name: "Priority",
        type: "select",
        options: { choices: [{ id: "ready", name: "Ready" }] },
      },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title", "priority"],
      },
    ],
  });
  const typedRow = rowEvent();
  typedRow.content = JSON.stringify({
    ...JSON.parse(typedRow.content),
    values: { title: "Original", priority: "ready" },
  });
  const mounted = await mountScreen({
    schemaEvents: [typedSchema],
    rowEvents: [typedRow],
  });
  try {
    const cell = await waitFor(() =>
      mounted.view.getByTestId(`database-cell-${ROW_ID}-priority`),
    );
    fireEvent.click(cell);
    fireEvent.change(mounted.view.getByLabelText("Edit Priority"), {
      target: { value: "" },
    });
    await waitFor(() => assert.equal(mounted.published.length, 1));
    const content = JSON.parse(mounted.published[0].content);
    assert.deepEqual(content.values, { title: "Original", priority: null });
  } finally {
    await mounted.restore();
  }
});

test("a signed per-view configuration restores the selected gallery after remount", async () => {
  const configured = schemaEvent();
  configured.content = JSON.stringify({
    ...JSON.parse(configured.content),
    views: [
      ...JSON.parse(configured.content).views,
      {
        id: "gallery",
        name: "Gallery",
        type: "gallery",
        filter: {
          kind: "rule",
          propertyId: "notes",
          operator: "contains",
          value: "keep",
        },
        sorts: [{ propertyId: "title", direction: "descending" }],
        group: { propertyId: "notes", direction: "ascending" },
        visiblePropertyIds: ["title", "notes"],
      },
    ],
  });
  const other = {
    ...rowEvent(),
    id: "3".repeat(64),
    created_at: 1_002,
    tags: [
      ["d", "dbrow:bbbbbbbb-2222-4222-8222-222222222222"],
      ["t", "community-db-row"],
      ["db", DATABASE_ID],
    ],
    content: JSON.stringify({
      values: { title: "Other", notes: "Archived" },
      docPageId: null,
      createdBy: AUTHOR,
      createdAt: 2,
      updatedAt: 2,
    }),
  };
  const mounted = await mountScreen({
    schemaEvents: [configured],
    rowEvents: [rowEvent(), other],
    viewId: "gallery",
  });
  try {
    const gallery = await mounted.view.findByTestId("database-gallery-surface");
    assert.equal(
      mounted.view
        .getByRole("tab", { name: "Gallery" })
        .getAttribute("aria-selected"),
      "true",
    );
    assert.match(gallery.textContent, /Original/);
    assert.doesNotMatch(gallery.textContent, /Other/);
    assert.match(gallery.textContent, /Keep me/);
  } finally {
    await mounted.restore();
  }
});
