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
    MutationObserver: dom.window.MutationObserver,
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        ["Element", "Node", "Event", "MouseEvent"].includes(key))
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

const SOURCE_DB = "11111111-2222-4333-8444-555555555555";
const TARGET_DB = "22222222-3333-4444-8555-666666666666";
const SOURCE_ROW = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SOURCE_ROW = "bbbbbbbb-2222-4222-8222-222222222222";
const TARGET_ROW = "cccccccc-3333-4333-8333-333333333333";
const MISSING_ROW = "dddddddd-4444-4444-8444-444444444444";

function row(id, databaseId, values, event = "1") {
  return {
    id,
    databaseId,
    values,
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    author: "b".repeat(64),
    eventId: event.repeat(64),
    eventCreatedAt: 1,
    eventKind: 30625,
    deleted: false,
  };
}

const authoritative = {
  id: "targets",
  name: "Targets",
  type: "relation",
  options: {
    databaseId: TARGET_DB,
    direction: "authoritative",
    mirroredPropertyId: "projects",
  },
};
const mirror = {
  id: "projects",
  name: "Projects",
  type: "relation",
  options: {
    databaseId: SOURCE_DB,
    direction: "mirror",
    mirroredPropertyId: "targets",
  },
};

function schema(id, properties) {
  return {
    id,
    name: id === SOURCE_DB ? "Projects" : "Targets",
    properties,
    views: [],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "f".repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

test("failed authoritative edit retries its links on the latest complete row and missing ids remain lookupable", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseRelationCell } = await import("./DatabaseRelationCell.tsx");
  const target = row(TARGET_ROW, TARGET_DB, { title: "Target" });
  const current = row(SOURCE_ROW, SOURCE_DB, {
    title: "Source",
    note: "old",
    targets: [TARGET_ROW, MISSING_ROW],
  });
  const rows = new Map([
    [SOURCE_ROW, current],
    [TARGET_ROW, target],
  ]);
  const schemas = new Map([
    [
      SOURCE_DB,
      schema(SOURCE_DB, [
        { id: "title", name: "Name", type: "title" },
        authoritative,
      ]),
    ],
    [
      TARGET_DB,
      schema(TARGET_DB, [{ id: "title", name: "Name", type: "title" }, mirror]),
    ],
  ]);
  const saves = [];
  const lookups = [];
  const context = {
    schemas,
    rows,
    lookupRow: async (id) => {
      lookups.push(id);
      return undefined;
    },
    onSaveRowValues: async (id, values, baseEventId) => {
      saves.push({ id, values, baseEventId });
      if (saves.length === 1) throw new Error("offline");
      return row(id, SOURCE_DB, values, "3");
    },
  };
  const view = render(
    React.createElement(DatabaseRelationCell, {
      context,
      property: authoritative,
      resolvedValue: current.values.targets,
      row: current,
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Remove relation Target" }));
  await waitFor(() =>
    view.getByRole("button", { name: "Retry Targets relation" }),
  );
  const newer = row(
    SOURCE_ROW,
    SOURCE_DB,
    { ...current.values, note: "remote" },
    "2",
  );
  rows.set(SOURCE_ROW, newer);
  view.rerender(
    React.createElement(DatabaseRelationCell, {
      context,
      property: authoritative,
      resolvedValue: newer.values.targets,
      row: newer,
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Retry Targets relation" }));
  await waitFor(() => assert.equal(saves.length, 2));
  assert.equal(saves[1].baseEventId, newer.eventId);
  assert.equal(saves[1].values.note, "remote");
  assert.deepEqual(saves[1].values.targets, [MISSING_ROW]);
  fireEvent.click(
    view.getByRole("button", {
      name: `Look up missing related row ${MISSING_ROW}`,
    }),
  );
  await waitFor(() => assert.deepEqual(lookups, [MISSING_ROW]));
});

test("mirror remove and add each publish exactly one authoritative source row snapshot", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseRelationCell } = await import("./DatabaseRelationCell.tsx");
  const source = row(SOURCE_ROW, SOURCE_DB, {
    title: "Alpha",
    note: "keep",
    targets: [TARGET_ROW],
  });
  const other = row(OTHER_SOURCE_ROW, SOURCE_DB, {
    title: "Beta",
    targets: [],
  });
  const target = row(TARGET_ROW, TARGET_DB, { title: "Target" });
  const rows = new Map([
    [SOURCE_ROW, source],
    [OTHER_SOURCE_ROW, other],
    [TARGET_ROW, target],
  ]);
  const schemas = new Map([
    [
      SOURCE_DB,
      schema(SOURCE_DB, [
        { id: "title", name: "Name", type: "title" },
        authoritative,
      ]),
    ],
    [
      TARGET_DB,
      schema(TARGET_DB, [{ id: "title", name: "Name", type: "title" }, mirror]),
    ],
  ]);
  const saves = [];
  const context = {
    schemas,
    rows,
    lookupRow: async () => undefined,
    onSaveRowValues: async (id, values, baseEventId) => {
      saves.push({ id, values, baseEventId });
      return row(id, SOURCE_DB, values, "4");
    },
  };
  const view = render(
    React.createElement(DatabaseRelationCell, {
      context,
      property: mirror,
      resolvedValue: [SOURCE_ROW],
      row: target,
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Remove relation Alpha" }));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.equal(saves[0].id, SOURCE_ROW);
  assert.deepEqual(saves[0].values.targets, []);
  assert.equal(saves[0].values.note, "keep");

  fireEvent.change(
    view.getByRole("combobox", { name: "Choose row for Projects" }),
    {
      target: { value: OTHER_SOURCE_ROW },
    },
  );
  fireEvent.click(view.getByRole("button", { name: "Add Projects relation" }));
  await waitFor(() => assert.equal(saves.length, 2));
  assert.equal(saves[1].id, OTHER_SOURCE_ROW);
  assert.deepEqual(saves[1].values.targets, [TARGET_ROW]);
});
