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

const DB = "11111111-2222-4333-8444-555555555555";
const TARGET_DB = "22222222-3333-4444-8555-666666666666";
const ROW_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ROW_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TARGET_A = "cccccccc-3333-4333-8333-333333333333";
const TARGET_B = "dddddddd-4444-4444-8444-444444444444";

function row(id, databaseId, values) {
  return {
    id,
    databaseId,
    values,
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    author: "b".repeat(64),
    eventId: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    eventCreatedAt: 1,
    eventKind: 30625,
    deleted: false,
  };
}

function schema(id, properties, views = []) {
  return {
    id,
    name: id === DB ? "Work" : "Scores",
    properties,
    views,
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: (id === DB ? "1" : "2").repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

test("Settings saves numeric formula and rollup filters/sorts plus relation membership in engine-valid shapes", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const { createDatabaseComputedResolver } = await import(
    "../lib/databaseComputedResolver.ts"
  );
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const relation = {
    id: "targets",
    name: "Targets",
    type: "relation",
    options: { databaseId: TARGET_DB, direction: "authoritative" },
  };
  const formula = {
    id: "double",
    name: "Double",
    type: "formula",
    options: { expression: 'prop("Effort") * 2', resultType: "number" },
  };
  const rollup = {
    id: "total",
    name: "Total",
    type: "rollup",
    options: {
      relationPropertyId: relation.id,
      targetPropertyId: "score",
      calculation: "sum",
      resultType: "number",
    },
  };
  const viewDefinition = {
    id: "table",
    name: "Table",
    type: "table",
    sorts: [],
    visiblePropertyIds: ["title", formula.id, rollup.id, relation.id],
  };
  const source = schema(
    DB,
    [
      { id: "title", name: "Name", type: "title" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "decimal" },
      },
      relation,
      formula,
      rollup,
    ],
    [viewDefinition],
  );
  const mutations = [];
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      schema: source,
      view: viewDefinition,
      onApply: (mutation) => mutations.push(mutation),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[0], {
    target: { value: formula.id },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[0], {
    target: { value: "greater_than" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter value")[0], {
    target: { value: "5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[1], {
    target: { value: relation.id },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[1], {
    target: { value: "contains" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter value")[1], {
    target: { value: TARGET_A },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
  fireEvent.change(screen.getByLabelText("Sort property"), {
    target: { value: rollup.id },
  });
  fireEvent.change(screen.getByLabelText("Sort direction"), {
    target: { value: "descending" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));
  assert.equal(mutations.length, 1);
  const saved = mutations[0](source);
  const savedView = saved.views[0];
  assert.equal(savedView.filter.filters[0].value, 5);
  assert.equal(savedView.filter.filters[1].value, TARGET_A);

  const target = schema(TARGET_DB, [
    { id: "title", name: "Name", type: "title" },
    {
      id: "score",
      name: "Score",
      type: "number",
      options: { format: "decimal" },
    },
  ]);
  const sourceRows = [
    row(ROW_A, DB, { title: "A", effort: 3, targets: [TARGET_A] }),
    row(ROW_B, DB, { title: "B", effort: 5, targets: [TARGET_A, TARGET_B] }),
  ];
  const rows = new Map([
    ...sourceRows.map((value) => [value.id, value]),
    [TARGET_A, row(TARGET_A, TARGET_DB, { title: "A", score: 4 })],
    [TARGET_B, row(TARGET_B, TARGET_DB, { title: "B", score: 10 })],
  ]);
  const resolver = createDatabaseComputedResolver({
    schemas: new Map([
      [DB, saved],
      [TARGET_DB, target],
    ]),
    rows,
    rowHistoryComplete: true,
  });
  const result = resolveDatabaseView({
    schema: saved,
    view: savedView,
    rows: sourceRows,
    resolveValue: resolver.resolveValue,
  });
  assert.deepEqual(
    result.rows.map(({ row: value }) => value.id),
    [ROW_B, ROW_A],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("Settings stores boolean and date formula/rollup filters that the resolver and engine accept", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const { createDatabaseComputedResolver } = await import(
    "../lib/databaseComputedResolver.ts"
  );
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const relation = {
    id: "targets",
    name: "Targets",
    type: "relation",
    options: { databaseId: TARGET_DB, direction: "authoritative" },
  };
  const computed = [
    {
      id: "done_formula",
      name: "Done formula",
      type: "formula",
      options: { expression: 'prop("Done")', resultType: "boolean" },
    },
    {
      id: "due_formula",
      name: "Due formula",
      type: "formula",
      options: { expression: 'prop("Due")', resultType: "date" },
    },
    {
      id: "done_rollup",
      name: "Done rollup",
      type: "rollup",
      options: {
        relationPropertyId: relation.id,
        targetPropertyId: "done",
        calculation: "show",
        resultType: "boolean_list",
      },
    },
    {
      id: "due_rollup",
      name: "Due rollup",
      type: "rollup",
      options: {
        relationPropertyId: relation.id,
        targetPropertyId: "due",
        calculation: "show",
        resultType: "date_list",
      },
    },
  ];
  const viewDefinition = {
    id: "table",
    name: "Table",
    type: "table",
    sorts: [],
    visiblePropertyIds: ["title", ...computed.map(({ id }) => id)],
  };
  const source = schema(
    DB,
    [
      { id: "title", name: "Name", type: "title" },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "due", name: "Due", type: "date" },
      relation,
      ...computed,
    ],
    [viewDefinition],
  );
  const mutations = [];
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      schema: source,
      view: viewDefinition,
      onApply: (mutation) => mutations.push(mutation),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  const addRule = () =>
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  const chooseProperty = (index, propertyId) =>
    fireEvent.change(screen.getAllByLabelText("Filter property")[index], {
      target: { value: propertyId },
    });
  chooseProperty(0, "done_formula");
  addRule();
  chooseProperty(1, "due_formula");
  fireEvent.change(screen.getAllByLabelText("Filter value")[1], {
    target: { value: "2026-09-09" },
  });
  addRule();
  chooseProperty(2, "done_rollup");
  fireEvent.change(screen.getAllByLabelText("Filter value")[2], {
    target: { value: "true" },
  });
  addRule();
  chooseProperty(3, "due_rollup");
  fireEvent.change(screen.getAllByLabelText("Filter value")[3], {
    target: { value: "2026-09-09" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));
  const saved = mutations[0](source);
  const filters = saved.views[0].filter.filters;
  assert.deepEqual(
    filters.map(({ value }) => value),
    [true, "2026-09-09", true, { start: "2026-09-09", includeTime: false }],
  );

  const date = { start: "2026-09-09", includeTime: false };
  const target = schema(TARGET_DB, [
    { id: "title", name: "Name", type: "title" },
    { id: "done", name: "Done", type: "checkbox" },
    { id: "due", name: "Due", type: "date" },
  ]);
  const sourceRows = [
    row(ROW_A, DB, { title: "A", done: true, due: date, targets: [TARGET_A] }),
    row(ROW_B, DB, { title: "B", done: false, due: date, targets: [TARGET_B] }),
  ];
  const rows = new Map([
    ...sourceRows.map((value) => [value.id, value]),
    [TARGET_A, row(TARGET_A, TARGET_DB, { title: "A", done: true, due: date })],
    [
      TARGET_B,
      row(TARGET_B, TARGET_DB, { title: "B", done: false, due: date }),
    ],
  ]);
  const resolver = createDatabaseComputedResolver({
    schemas: new Map([
      [DB, saved],
      [TARGET_DB, target],
    ]),
    rows,
    rowHistoryComplete: true,
  });
  const result = resolveDatabaseView({
    schema: saved,
    view: saved.views[0],
    rows: sourceRows,
    resolveValue: resolver.resolveValue,
  });
  assert.deepEqual(
    result.rows.map(({ row: value }) => value.id),
    [ROW_A],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("a declared computed type mismatch is diagnostic and cannot match", async () => {
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const computed = {
    id: "wrong",
    name: "Wrong",
    type: "formula",
    options: { expression: "1", resultType: "boolean" },
  };
  const view = {
    id: "table",
    name: "Table",
    type: "table",
    filter: {
      kind: "rule",
      propertyId: computed.id,
      operator: "equals",
      value: true,
    },
    sorts: [],
    visiblePropertyIds: ["title", computed.id],
  };
  const source = schema(
    DB,
    [{ id: "title", name: "Name", type: "title" }, computed],
    [view],
  );
  const result = resolveDatabaseView({
    schema: source,
    view,
    rows: [row(ROW_A, DB, { title: "A" })],
    resolveValue: () => 1,
  });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.diagnostics, [
    { kind: "invalid_value", propertyId: computed.id },
  ]);
});
