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
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
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
      if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
    }
  }
});
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
after(() => dom.window.close());

function schema() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Work",
    properties: [{ id: "title", name: "Name", type: "title" }],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title"],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "1".repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

test("route-free view surface preserves a missing explicit view until the user recovers it", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSurface } = await import("./DatabaseViewSurface.tsx");
  const selected = [];
  const source = schema();
  const screen = render(
    React.createElement(DatabaseViewSurface, {
      onAddRow: async () => {
        throw new Error("unused");
      },
      onSaveRowValues: async () => {
        throw new Error("unused");
      },
      onSaveSchema: async () => source,
      onSelectView: (id) => selected.push(id),
      rows: [],
      schema: source,
      viewId: "missing",
    }),
  );
  assert.deepEqual(selected, []);
  assert.ok(screen.getByTestId("database-missing-view"));
  assert.match(screen.getByRole("alert").textContent, /unavailable/u);
  fireEvent.change(screen.getByLabelText("Available database view"), {
    target: { value: "table" },
  });
  assert.deepEqual(selected, ["table"]);
});

test("an absent view id displays the first view without emitting selection", async () => {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { DatabaseViewSurface } = await import("./DatabaseViewSurface.tsx");
  const selected = [];
  const source = schema();
  const screen = render(
    React.createElement(DatabaseViewSurface, {
      onAddRow: async () => {
        throw new Error("unused");
      },
      onSaveRowValues: async () => {
        throw new Error("unused");
      },
      onSaveSchema: async () => source,
      onSelectView: (id) => selected.push(id),
      rows: [],
      schema: source,
    }),
  );
  assert.deepEqual(selected, []);
  assert.ok(screen.getByRole("tab", { name: "Table" }));
  assert.ok(screen.getByTestId("database-table-surface"));
});

test("failed view mutation keeps its local intent and retries on the newest accepted schema", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseConflictError } = await import(
    "../lib/useCommunityDatabases.ts"
  );
  const { DatabaseViewSurface } = await import("./DatabaseViewSurface.tsx");
  const source = schema();
  const remote = {
    ...source,
    properties: [
      ...source.properties,
      { id: "remote", name: "Remote", type: "text" },
    ],
    eventId: "2".repeat(64),
    eventCreatedAt: 2,
  };
  const calls = [];
  let conflict = true;
  const screen = render(
    React.createElement(DatabaseViewSurface, {
      onAddRow: async () => {
        throw new Error("unused");
      },
      onSaveRowValues: async () => {
        throw new Error("unused");
      },
      onSaveSchema: async (content, baseEventId) => {
        calls.push({ content, baseEventId });
        if (conflict) {
          conflict = false;
          throw new DatabaseConflictError(remote);
        }
        return {
          ...remote,
          ...content,
          eventId: "3".repeat(64),
          eventCreatedAt: 3,
        };
      },
      onSelectView: () => {},
      rows: [],
      schema: source,
      viewId: "table",
    }),
  );
  const name = screen.getByLabelText("View name");
  fireEvent.change(name, { target: { value: "My table" } });
  fireEvent.blur(name);
  const retry = await screen.findByRole("button", {
    name: "Retry view change",
  });
  assert.equal(screen.getByLabelText("View name").value, "My table");
  assert.equal(calls[0].baseEventId, source.eventId);
  fireEvent.click(retry);
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].baseEventId, remote.eventId);
  assert.equal(calls[1].content.views[0].name, "My table");
  assert.equal(calls[1].content.properties.at(-1).name, "Remote");
});

test("a grouped table keeps one new-row action and saved column widths", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseViewSurface } = await import("./DatabaseViewSurface.tsx");
  const source = schema();
  source.properties.push({
    id: "status",
    name: "Status",
    type: "select",
    options: { choices: [{ id: "ready", name: "Ready" }] },
  });
  source.views[0] = {
    ...source.views[0],
    group: { propertyId: "status", direction: "ascending" },
    visiblePropertyIds: ["title", "status"],
    propertyWidths: { title: 264, status: 132 },
  };
  const candidate = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    databaseId: source.id,
    values: { title: "Launch", status: "ready" },
    docPageId: null,
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "2".repeat(64),
    eventCreatedAt: 1,
  };
  let additions = 0;
  const screen = render(
    React.createElement(DatabaseViewSurface, {
      onAddRow: async () => {
        additions += 1;
        return candidate;
      },
      onSaveRowValues: async () => {
        throw new Error("unused");
      },
      onSaveSchema: async () => source,
      onSelectView: () => {},
      rows: [candidate],
      schema: source,
      viewId: "table",
    }),
  );

  const addButtons = screen.getAllByRole("button", { name: "New row" });
  assert.equal(addButtons.length, 1);
  fireEvent.click(addButtons[0]);
  await waitFor(() => assert.equal(additions, 1));
  assert.equal(
    screen.getByTestId(`database-cell-${candidate.id}-title`).style.width,
    "264px",
  );
  assert.equal(
    screen.getByTestId(`database-cell-${candidate.id}-status`).style.width,
    "132px",
  );
});

test("computed errors stay visible above table, board, calendar, and gallery renderers", async () => {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { DatabaseViewSurface } = await import("./DatabaseViewSurface.tsx");
  const source = schema();
  source.properties.push(
    {
      id: "status",
      name: "Status",
      type: "select",
      options: { choices: [{ id: "ready", name: "Ready" }] },
    },
    { id: "due", name: "Due", type: "date" },
    {
      id: "formula",
      name: "Formula",
      type: "formula",
      options: { expression: "divide(1, 0)" },
    },
  );
  source.views = [
    {
      id: "table",
      name: "Table",
      type: "table",
      sorts: [],
      visiblePropertyIds: ["title", "formula"],
    },
    {
      id: "board",
      name: "Board",
      type: "board",
      sorts: [],
      group: { propertyId: "status", direction: "ascending" },
      visiblePropertyIds: ["title"],
    },
    {
      id: "calendar",
      name: "Calendar",
      type: "calendar",
      sorts: [],
      group: { propertyId: "due", direction: "ascending" },
      visiblePropertyIds: ["title"],
    },
    {
      id: "gallery",
      name: "Gallery",
      type: "gallery",
      sorts: [],
      visiblePropertyIds: ["title"],
    },
  ];
  const candidate = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    databaseId: source.id,
    values: {
      title: "Launch",
      status: "ready",
      due: { start: "2026-09-09", includeTime: false },
    },
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "2".repeat(64),
    eventCreatedAt: 1,
    eventKind: 30625,
    deleted: false,
  };
  const error = {
    kind: "computed_error",
    code: "DIVIDE_BY_ZERO",
    detail: "Cannot divide by zero.",
  };
  const props = {
    onAddRow: async () => candidate,
    onSaveRowValues: async () => candidate,
    onSaveSchema: async () => source,
    onSelectView: () => {},
    resolveValue: (row, property) =>
      property.id === "formula" ? error : (row.values[property.id] ?? null),
    rows: [candidate],
    schema: source,
  };
  const screen = render(
    React.createElement(DatabaseViewSurface, { ...props, viewId: "table" }),
  );
  for (const viewId of ["table", "board", "calendar", "gallery"]) {
    screen.rerender(
      React.createElement(DatabaseViewSurface, { ...props, viewId }),
    );
    assert.match(
      screen.getByTestId("database-computed-errors").textContent,
      /DIVIDE_BY_ZERO/u,
      viewId,
    );
  }
});
