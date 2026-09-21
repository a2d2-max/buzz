import assert from "node:assert/strict";
import test from "node:test";

function schema() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Work",
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
        propertyWidths: { title: 240 },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("column commands persist order, visibility, and final width in the saved view", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  let current = commands.addDatabaseProperty(schema(), {
    id: "effort",
    name: "Effort",
    type: "number",
    options: { format: "integer" },
  });
  assert.deepEqual(current.views[0].visiblePropertyIds, [
    "title",
    "notes",
    "effort",
  ]);
  current = commands.moveDatabaseProperty(current, "table", "effort", -1);
  assert.deepEqual(current.views[0].visiblePropertyIds, [
    "title",
    "effort",
    "notes",
  ]);
  current = commands.setDatabasePropertyVisible(
    current,
    "table",
    "notes",
    false,
  );
  assert.deepEqual(current.views[0].visiblePropertyIds, ["title", "effort"]);
  current = commands.setDatabasePropertyVisible(
    current,
    "table",
    "notes",
    true,
  );
  current = commands.setDatabasePropertyWidth(current, "table", "effort", 333);
  assert.deepEqual(current.views[0].visiblePropertyIds, [
    "title",
    "effort",
    "notes",
  ]);
  assert.equal(current.views[0].propertyWidths.effort, 333);
});

test("title changes are atomic and every schema keeps exactly one title", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  assert.throws(
    () => commands.changeDatabasePropertyType(schema(), "title", "number"),
    /promote another property/i,
  );
  const promoted = commands.changeDatabasePropertyType(
    schema(),
    "notes",
    "title",
  );
  assert.deepEqual(
    promoted.properties.map(({ id, type }) => ({ id, type })),
    [
      { id: "title", type: "text" },
      { id: "notes", type: "title" },
    ],
  );
  assert.equal(
    promoted.properties.filter((property) => property.type === "title").length,
    1,
  );
});

test("same-type changes preserve the sole title and type-specific options", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  const original = commands.addDatabaseProperty(schema(), {
    id: "priority",
    name: "Priority",
    type: "select",
    options: { choices: [{ id: "high", name: "High", color: "red" }] },
  });
  assert.equal(
    commands.changeDatabasePropertyType(original, "title", "title"),
    original,
  );
  assert.equal(
    commands.changeDatabasePropertyType(original, "priority", "select"),
    original,
  );
  assert.equal(
    original.properties.filter((property) => property.type === "title").length,
    1,
  );
  assert.deepEqual(original.properties[2].options.choices, [
    { id: "high", name: "High", color: "red" },
  ]);
});

test("type changes persist and restore prior definitions with their options", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  let current = commands.addDatabaseProperty(schema(), {
    id: "priority",
    name: "Priority",
    type: "select",
    options: { choices: [{ id: "ready", name: "Ready", color: "green" }] },
  });
  current = commands.changeDatabasePropertyType(current, "priority", "text");
  assert.deepEqual(current.properties[2].priorDefinitions, [
    {
      type: "select",
      options: {
        choices: [{ id: "ready", name: "Ready", color: "green" }],
      },
    },
  ]);

  current = commands.changeDatabasePropertyType(current, "priority", "number");
  current = {
    ...current,
    properties: current.properties.map((property) =>
      property.id === "priority"
        ? { ...property, options: { format: "won" } }
        : property,
    ),
  };
  current = commands.changeDatabasePropertyType(current, "priority", "select");
  assert.deepEqual(current.properties[2].options.choices, [
    { id: "ready", name: "Ready", color: "green" },
  ]);
  current = commands.changeDatabasePropertyType(current, "priority", "number");
  assert.equal(current.properties[2].options.format, "won");

  const withMulti = commands.addDatabaseProperty(current, {
    id: "teams",
    name: "Teams",
    type: "multi_select",
    options: { choices: [{ id: "desktop", name: "Desktop" }] },
  });
  const changed = commands.changeDatabasePropertyType(
    withMulti,
    "teams",
    "text",
  );
  const restored = commands.changeDatabasePropertyType(
    changed,
    "teams",
    "multi_select",
  );
  assert.deepEqual(restored.properties[3].options.choices, [
    { id: "desktop", name: "Desktop" },
  ]);
});

test("computed type overrides archive and restore exact formula and rollup definitions", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  let current = commands.addDatabaseProperty(schema(), {
    id: "computed",
    name: "Computed",
    type: "formula",
    options: { expression: 'prop("Notes")', resultType: "text" },
  });
  current = commands.changeDatabasePropertyType(current, "computed", "rollup", {
    type: "rollup",
    options: {
      relationPropertyId: "relation",
      targetPropertyId: "score",
      calculation: "sum",
      resultType: "number",
    },
  });
  assert.deepEqual(current.properties[2].priorDefinitions, [
    {
      type: "formula",
      options: { expression: 'prop("Notes")', resultType: "text" },
    },
  ]);
  current = commands.changeDatabasePropertyType(current, "computed", "formula");
  assert.deepEqual(current.properties[2].options, {
    expression: 'prop("Notes")',
    resultType: "text",
  });
  assert.equal(current.properties[2].priorDefinitions[0].type, "rollup");
});

test("automatic columns cannot be edited and title cannot be hidden", async () => {
  const commands = await import("./databaseSchemaCommands.ts");
  const withCreated = commands.addDatabaseProperty(schema(), {
    id: "created",
    name: "Created",
    type: "created_time",
  });
  assert.equal(
    commands.databasePropertyIsReadOnly(withCreated.properties[2]),
    true,
  );
  assert.throws(
    () =>
      commands.setDatabasePropertyVisible(withCreated, "table", "title", false),
    /title.*visible/i,
  );
});
