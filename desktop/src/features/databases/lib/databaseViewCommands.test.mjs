import assert from "node:assert/strict";
import test from "node:test";

function schema() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
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
        priorDefinitions: [{ type: "text" }],
      },
      { id: "due", name: "Due", type: "date" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "decimal" },
      },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title", "status", "due", "effort"],
        propertyWidths: { title: 240 },
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  };
}

test("view creation uses compatible defaults and unique identity", async () => {
  const { createDatabaseView } = await import("./databaseViewCommands.ts");
  let current = createDatabaseView(schema(), {
    id: "board",
    name: "Board",
    type: "board",
  });
  assert.equal(current.views[1].group.propertyId, "status");
  assert.deepEqual(current.views[1].visiblePropertyIds, [
    "title",
    "status",
    "due",
    "effort",
  ]);
  current = createDatabaseView(current, {
    id: "calendar",
    name: "Calendar",
    type: "calendar",
  });
  assert.equal(current.views[2].group.propertyId, "due");
  assert.throws(
    () =>
      createDatabaseView(current, {
        id: "board",
        name: "Again",
        type: "gallery",
      }),
    /already exists/i,
  );
});

test("rename and type changes preserve target configuration and every sibling", async () => {
  const commands = await import("./databaseViewCommands.ts");
  const withBoard = commands.createDatabaseView(schema(), {
    id: "board",
    name: "Board",
    type: "board",
  });
  const originalTable = withBoard.views[0];
  let current = commands.renameDatabaseView(withBoard, "board", "  Sprint  ");
  current = commands.changeDatabaseViewType(current, "board", "gallery");
  assert.equal(current.views[0], originalTable);
  assert.equal(current.views[1].name, "Sprint");
  assert.equal(current.views[1].type, "gallery");
  assert.equal(current.views[1].group.propertyId, "status");
  assert.deepEqual(current.views[1].propertyWidths, { title: 240 });
});

test("typed filter sort and group commands validate references and preserve order", async () => {
  const commands = await import("./databaseViewCommands.ts");
  const nested = {
    kind: "group",
    operator: "or",
    filters: [
      {
        kind: "rule",
        propertyId: "status",
        operator: "equals",
        value: "doing",
      },
      {
        kind: "rule",
        propertyId: "effort",
        operator: "greater_than",
        value: 3,
      },
    ],
  };
  let current = commands.setDatabaseViewFilter(schema(), "table", nested);
  current = commands.setDatabaseViewSorts(current, "table", [
    { propertyId: "status", direction: "ascending" },
    { propertyId: "effort", direction: "descending" },
  ]);
  current = commands.setDatabaseViewGroup(current, "table", {
    propertyId: "status",
    direction: "descending",
  });
  assert.deepEqual(current.views[0].filter, nested);
  assert.deepEqual(
    current.views[0].sorts.map(({ propertyId }) => propertyId),
    ["status", "effort"],
  );
  assert.equal(current.views[0].group.direction, "descending");
  assert.throws(
    () =>
      commands.setDatabaseViewSorts(current, "table", [
        { propertyId: "status", direction: "ascending" },
        { propertyId: "status", direction: "descending" },
      ]),
    /duplicate/i,
  );
  assert.throws(
    () =>
      commands.setDatabaseViewGroup(current, "table", {
        propertyId: "missing",
        direction: "ascending",
      }),
    /property/i,
  );
  assert.throws(
    () =>
      commands.setDatabaseViewFilter(current, "table", {
        kind: "group",
        operator: "and",
        filters: [],
      }),
    /empty/i,
  );
});

test("board and calendar grouping reject incompatible property types", async () => {
  const commands = await import("./databaseViewCommands.ts");
  const board = commands.createDatabaseView(schema(), {
    id: "board",
    name: "Board",
    type: "board",
  });
  assert.throws(
    () =>
      commands.setDatabaseViewGroup(board, "board", {
        propertyId: "due",
        direction: "ascending",
      }),
    /board/i,
  );
  const calendar = commands.createDatabaseView(schema(), {
    id: "calendar",
    name: "Calendar",
    type: "calendar",
  });
  assert.throws(
    () =>
      commands.setDatabaseViewGroup(calendar, "calendar", {
        propertyId: "status",
        direction: "ascending",
      }),
    /calendar/i,
  );
});

test("status defaults and choice updates keep semantic groups and prior definitions", async () => {
  const schemaCommands = await import("./databaseSchemaCommands.ts");
  const { updateDatabaseStatusChoices } = await import(
    "./databaseViewCommands.ts"
  );
  const fresh = schemaCommands.defaultDatabaseProperty(
    "workflow",
    "Workflow",
    "status",
  );
  assert.deepEqual(
    fresh.options.choices.map(({ id, name, group }) => ({ id, name, group })),
    [
      { id: "todo", name: "To do", group: "todo" },
      { id: "doing", name: "In progress", group: "doing" },
      { id: "done", name: "Done", group: "done" },
    ],
  );
  const current = updateDatabaseStatusChoices(schema(), "status", [
    { name: "In progress", group: "doing" },
    { name: "Ready", group: "todo", id: "ready" },
  ]);
  const status = current.properties.find(
    (property) => property.id === "status",
  );
  assert.equal(status.options.choices[0].id, "doing");
  assert.equal(status.options.choices[1].id, "ready");
  assert.deepEqual(status.priorDefinitions, [{ type: "text" }]);
});
