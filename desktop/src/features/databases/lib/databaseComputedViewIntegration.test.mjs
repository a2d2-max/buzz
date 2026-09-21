import assert from "node:assert/strict";
import test from "node:test";

const DB = "11111111-2222-4333-8444-555555555555";
const TARGET_DB = "22222222-3333-4444-8555-666666666666";
const ROW_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ROW_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TARGET = "cccccccc-3333-4333-8333-333333333333";

function schema(id, properties, views = []) {
  return {
    id,
    name: id === DB ? "Work" : "Targets",
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

test("formula numbers and relation membership flow through typed filters and stable sorting", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
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
    options: { expression: 'prop("Effort") * 2' },
  };
  const properties = [
    { id: "title", name: "Name", type: "title" },
    {
      id: "effort",
      name: "Effort",
      type: "number",
      options: { format: "decimal" },
    },
    relation,
    formula,
  ];
  const view = {
    id: "table",
    name: "Table",
    type: "table",
    filter: {
      kind: "group",
      operator: "and",
      filters: [
        {
          kind: "rule",
          propertyId: formula.id,
          operator: "greater_than",
          value: 5,
        },
        {
          kind: "rule",
          propertyId: relation.id,
          operator: "contains",
          value: TARGET,
        },
      ],
    },
    sorts: [{ propertyId: formula.id, direction: "descending" }],
    visiblePropertyIds: ["title", formula.id],
  };
  const source = schema(DB, properties, [view]);
  const target = schema(TARGET_DB, [
    { id: "title", name: "Name", type: "title" },
  ]);
  const sourceRows = [
    row(ROW_A, DB, { title: "A", effort: 3, targets: [TARGET] }),
    row(ROW_B, DB, { title: "B", effort: 5, targets: [TARGET] }),
  ];
  const rows = new Map([
    ...sourceRows.map((value) => [value.id, value]),
    [TARGET, row(TARGET, TARGET_DB, { title: "Target" })],
  ]);
  const resolver = createDatabaseComputedResolver({
    schemas: new Map([
      [DB, source],
      [TARGET_DB, target],
    ]),
    rows,
    rowHistoryComplete: true,
  });
  const result = resolveDatabaseView({
    schema: source,
    view,
    rows: sourceRows,
    resolveValue: resolver.resolveValue,
  });
  assert.deepEqual(
    result.rows.map(({ row: value }) => value.id),
    [ROW_B, ROW_A],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("computed errors never match empty filters, sort after values, and group explicitly", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const formula = {
    id: "ratio",
    name: "Ratio",
    type: "formula",
    options: { expression: 'divide(10, prop("Denominator"))' },
  };
  const properties = [
    { id: "title", name: "Name", type: "title" },
    {
      id: "denominator",
      name: "Denominator",
      type: "number",
      options: { format: "decimal" },
    },
    formula,
  ];
  const source = schema(DB, properties);
  const rows = [
    row(ROW_A, DB, { title: "Good", denominator: 2 }),
    row(ROW_B, DB, { title: "Error", denominator: 0 }),
  ];
  const resolver = createDatabaseComputedResolver({
    schemas: new Map([[DB, source]]),
    rows: new Map(rows.map((value) => [value.id, value])),
    rowHistoryComplete: true,
  });
  const result = resolveDatabaseView({
    schema: source,
    rows,
    resolveValue: resolver.resolveValue,
    view: {
      id: "table",
      name: "Table",
      type: "table",
      filter: {
        kind: "rule",
        propertyId: formula.id,
        operator: "is_not_empty",
      },
      sorts: [{ propertyId: formula.id, direction: "ascending" }],
      group: { propertyId: formula.id, direction: "ascending" },
      visiblePropertyIds: ["title", formula.id],
    },
  });
  assert.deepEqual(
    result.rows.map(({ row: value }) => value.id),
    [ROW_A],
  );
  assert.equal(result.computedErrors.length, 1);

  const grouped = resolveDatabaseView({
    schema: source,
    rows,
    resolveValue: resolver.resolveValue,
    view: {
      id: "gallery",
      name: "Gallery",
      type: "gallery",
      sorts: [],
      group: { propertyId: formula.id, direction: "ascending" },
      visiblePropertyIds: ["title", formula.id],
    },
  });
  assert.equal(
    grouped.groups.some(({ key }) => key.startsWith("error:DIVIDE_BY_ZERO")),
    true,
  );
  assert.equal(
    grouped.groups.find(({ key }) => key.startsWith("error:"))?.recoverable,
    true,
  );
});

test("now and today resolve as declared dates and cross date filters with the supplied clock", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const nowProperty = {
    id: "clock_now",
    name: "Now",
    type: "formula",
    options: { expression: "now()", resultType: "date" },
  };
  const todayProperty = {
    id: "clock_today",
    name: "Today",
    type: "formula",
    options: { expression: "today()", resultType: "date" },
  };
  const view = {
    id: "table",
    name: "Table",
    type: "table",
    filter: {
      kind: "rule",
      propertyId: nowProperty.id,
      operator: "after",
      value: "2026-09-09T04:00:30.000Z",
    },
    sorts: [{ propertyId: todayProperty.id, direction: "ascending" }],
    visiblePropertyIds: ["title", nowProperty.id, todayProperty.id],
  };
  const source = schema(
    DB,
    [{ id: "title", name: "Name", type: "title" }, nowProperty, todayProperty],
    [view],
  );
  const current = row(ROW_A, DB, { title: "A" });
  const resolveAt = (nowMs) => {
    const resolver = createDatabaseComputedResolver({
      nowMs,
      schemas: new Map([[DB, source]]),
      rows: new Map([[current.id, current]]),
      rowHistoryComplete: true,
    });
    return resolveDatabaseView({
      schema: source,
      view,
      rows: [current],
      resolveValue: resolver.resolveValue,
    });
  };
  const before = resolveAt(Date.parse("2026-09-09T04:00:00.000Z"));
  assert.deepEqual(before.rows, []);
  const after = resolveAt(Date.parse("2026-09-09T04:01:00.000Z"));
  assert.deepEqual(
    after.rows.map(({ row: value }) => value.id),
    [ROW_A],
  );
  assert.deepEqual(after.diagnostics, []);
  assert.deepEqual(after.rows[0].values.get(todayProperty.id), {
    start: "2026-09-09",
    includeTime: false,
  });
});
