import assert from "node:assert/strict";
import test from "node:test";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";

function schema() {
  return {
    id: DATABASE_ID,
    name: "Work",
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: {
          choices: [
            { id: "todo", name: "To do", group: "todo" },
            { id: "doing", name: "In progress", group: "doing" },
            { id: "done", name: "Done", group: "done" },
          ],
        },
      },
      {
        id: "priority",
        name: "Priority",
        type: "select",
        options: {
          choices: [
            { id: "high", name: "High" },
            { id: "low", name: "Low" },
          ],
        },
      },
      { id: "people", name: "People", type: "person" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "decimal" },
      },
      { id: "ready", name: "Ready", type: "checkbox" },
      { id: "due", name: "Due", type: "date" },
      { id: "created", name: "Created", type: "created_time" },
    ],
    views: [],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "1".repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

function row(id, values, createdAt = 1) {
  return {
    id,
    databaseId: DATABASE_ID,
    values,
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt,
    updatedAt: createdAt,
    author: "b".repeat(64),
    eventId: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    eventCreatedAt: createdAt,
    eventKind: 30625,
    deleted: false,
  };
}

const IDS = [
  "aaaaaaaa-1111-4111-8111-111111111111",
  "bbbbbbbb-2222-4222-8222-222222222222",
  "cccccccc-3333-4333-8333-333333333333",
];

function view(overrides = {}) {
  return {
    id: "table",
    name: "Table",
    type: "table",
    sorts: [],
    visiblePropertyIds: ["title", "priority", "effort"],
    ...overrides,
  };
}

test("filter keeps false and zero as values while matching actual empty cells", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[0], { title: "Zero", effort: 0, ready: false }),
    row(IDS[1], { title: "Empty", effort: null, ready: null }),
  ];
  const nonEmpty = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: { kind: "rule", propertyId: "effort", operator: "is_not_empty" },
    }),
  });
  assert.deepEqual(
    nonEmpty.rows.map(({ row }) => row.id),
    [IDS[0]],
  );

  const unchecked = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: { kind: "rule", propertyId: "ready", operator: "is_not_checked" },
    }),
  });
  assert.deepEqual(
    unchecked.rows.map(({ row }) => row.id),
    [IDS[0]],
  );
});

test("nested AND and OR filters use typed text and stable choice ids", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[0], { title: "Launch Alpha", priority: "high", effort: 3 }),
    row(IDS[1], { title: "launch beta", priority: "low", effort: 5 }),
    row(IDS[2], { title: "Archive", priority: "high", effort: 8 }),
  ];
  const result = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: {
        kind: "group",
        operator: "and",
        filters: [
          {
            kind: "rule",
            propertyId: "title",
            operator: "contains",
            value: "LAUNCH",
          },
          {
            kind: "group",
            operator: "or",
            filters: [
              {
                kind: "rule",
                propertyId: "priority",
                operator: "equals",
                value: "high",
              },
              {
                kind: "rule",
                propertyId: "effort",
                operator: "greater_than",
                value: 4,
              },
            ],
          },
        ],
      },
    }),
  });
  assert.deepEqual(
    result.rows.map(({ row }) => row.id),
    [IDS[0], IDS[1]],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("date filters validate date-only and timed bounds with inclusive between semantics", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[0], { due: { start: "2026-09-08", includeTime: false } }),
    row(IDS[1], {
      due: { start: "2026-09-09T01:00:00+09:00", includeTime: true },
    }),
    row(IDS[2], { due: { start: "2026-02-30", includeTime: false } }),
  ];
  const dateOnly = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: {
        kind: "rule",
        propertyId: "due",
        operator: "between",
        value: ["2026-09-08", "2026-09-08"],
      },
    }),
  });
  assert.deepEqual(
    dateOnly.rows.map(({ row }) => row.id),
    [IDS[0]],
  );
  const timed = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: {
        kind: "rule",
        propertyId: "due",
        operator: "on_or_after",
        value: "2026-09-08T16:00:00Z",
      },
    }),
  });
  assert.deepEqual(
    timed.rows.map(({ row }) => row.id),
    [IDS[1]],
  );
});

test("ordered multi-sort is stable with empty last and row id as the final tie", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[2], { title: "C", priority: "high", effort: 2 }),
    row(IDS[0], { title: "A", priority: "high", effort: 2 }),
    row(IDS[1], { title: "B", priority: "low", effort: null }),
  ];
  const result = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      sorts: [
        { propertyId: "priority", direction: "ascending" },
        { propertyId: "effort", direction: "descending" },
      ],
    }),
  });
  assert.deepEqual(
    result.rows.map(({ row }) => row.id),
    [IDS[0], IDS[2], IDS[1]],
  );
});

test("select grouping follows choice order and includes unknown and explicit Empty recovery", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[0], { priority: "low" }),
    row(IDS[1], { priority: "removed" }),
    row(IDS[2], { priority: null }),
  ];
  const result = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({ group: { propertyId: "priority", direction: "descending" } }),
  });
  assert.deepEqual(
    result.groups.map(({ label }) => label),
    ["Low", "High", "Unknown option (removed)", "Empty"],
  );
  assert.equal(result.groups[2].recoverable, true);
  assert.equal(result.groups[3].empty, true);
});

test("person grouping places a row in every person group and keeps Empty last", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const rows = [
    row(IDS[0], { people: [alice, bob] }),
    row(IDS[1], { people: [] }),
  ];
  const result = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({ group: { propertyId: "people", direction: "ascending" } }),
  });
  assert.deepEqual(
    result.groups.map(({ label }) => label),
    ["aaaaaaaa…aaaa", "bbbbbbbb…bbbb", "Empty"],
  );
  assert.deepEqual(
    result.groups[0].rows.map(({ row }) => row.id),
    [IDS[0]],
  );
  assert.deepEqual(
    result.groups[1].rows.map(({ row }) => row.id),
    [IDS[0]],
  );
});

test("injected values drive one shared filter sort and group pass and report bad rules", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [row(IDS[0], { title: "A" }), row(IDS[1], { title: "B" })];
  const calls = new Map();
  const resolveValue = (candidate, property) => {
    const key = `${candidate.id}:${property.id}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (property.id === "effort") return candidate.id === IDS[0] ? 9 : 2;
    if (property.id === "priority")
      return candidate.id === IDS[0] ? "high" : "low";
    return candidate.values[property.id] ?? null;
  };
  const result = resolveDatabaseView({
    schema: schema(),
    rows,
    resolveValue,
    view: view({
      filter: {
        kind: "rule",
        propertyId: "effort",
        operator: "greater_than",
        value: 3,
      },
      sorts: [{ propertyId: "effort", direction: "descending" }],
      group: { propertyId: "priority", direction: "ascending" },
    }),
  });
  assert.deepEqual(
    result.rows.map(({ row }) => row.id),
    [IDS[0]],
  );
  assert.equal(calls.get(`${IDS[0]}:effort`), 1);
  assert.equal(calls.get(`${IDS[0]}:priority`), 1);

  const invalid = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      filter: {
        kind: "rule",
        propertyId: "missing",
        operator: "equals",
        value: "x",
      },
      group: { propertyId: "missing", direction: "ascending" },
    }),
  });
  assert.deepEqual(invalid.rows, []);
  assert.equal(invalid.groupError, "unknown");
  assert.deepEqual(
    invalid.diagnostics.map(({ kind }) => kind),
    ["missing_property"],
  );
});

test("filter diagnostics are structural on empty rows and do not depend on OR short circuiting", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const invalidRule = {
    kind: "rule",
    propertyId: "title",
    operator: "before",
    value: "x",
  };
  const empty = resolveDatabaseView({
    schema: schema(),
    rows: [],
    view: view({ filter: invalidRule }),
  });
  assert.deepEqual(empty.diagnostics, [
    { kind: "invalid_operator", propertyId: "title" },
  ]);
  const shortCircuited = resolveDatabaseView({
    schema: schema(),
    rows: [row(IDS[0], { title: "Launch" })],
    view: view({
      filter: {
        kind: "group",
        operator: "or",
        filters: [
          {
            kind: "rule",
            propertyId: "title",
            operator: "equals",
            value: "launch",
          },
          invalidRule,
        ],
      },
    }),
  });
  assert.equal(shortCircuited.rows.length, 1);
  assert.deepEqual(shortCircuited.diagnostics, [
    { kind: "invalid_operator", propertyId: "title" },
  ]);
});

test("strict computed numbers and timed dates never normalize into successful matches", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const numeric = resolveDatabaseView({
    schema: schema(),
    rows: [row(IDS[0], {})],
    resolveValue: (_row, property) =>
      property.id === "effort" ? Number.NaN : null,
    view: view({
      filter: {
        kind: "rule",
        propertyId: "effort",
        operator: "greater_than",
        value: 3,
      },
    }),
  });
  assert.deepEqual(numeric.rows, []);
  const timed = resolveDatabaseView({
    schema: schema(),
    rows: [
      row(IDS[0], {
        due: { start: "2026-02-30T09:00:00Z", includeTime: true },
      }),
    ],
    view: view({
      filter: {
        kind: "rule",
        propertyId: "due",
        operator: "after",
        value: "2026-02-01T00:00:00Z",
      },
    }),
  });
  assert.deepEqual(timed.rows, []);
});

test("view-specific incompatible groups stay visible as recoverable configuration", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const rows = [
    row(IDS[0], { due: { start: "2026-09-09", includeTime: false } }),
  ];
  const board = resolveDatabaseView({
    schema: schema(),
    rows,
    view: view({
      type: "board",
      group: { propertyId: "due", direction: "ascending" },
    }),
  });
  assert.equal(board.groupError, "incompatible");
  assert.equal(board.groupProperty.id, "due");
  assert.deepEqual(
    board.rows.map(({ row }) => row.id),
    [IDS[0]],
  );
  assert.deepEqual(board.groups, []);
});

test("status groups follow semantic workflow order before schema order", async () => {
  const { resolveDatabaseView } = await import("./databaseViewEngine.ts");
  const custom = schema();
  custom.properties = custom.properties.map((property) =>
    property.id === "status"
      ? {
          ...property,
          options: {
            choices: [
              { id: "done", name: "Done", group: "done" },
              { id: "todo", name: "To do", group: "todo" },
              { id: "doing", name: "In progress", group: "doing" },
            ],
          },
        }
      : property,
  );
  const result = resolveDatabaseView({
    schema: custom,
    rows: [],
    view: view({ group: { propertyId: "status", direction: "ascending" } }),
  });
  assert.deepEqual(
    result.groups.map(({ label }) => label),
    ["To do", "In progress", "Done", "Empty"],
  );
});
