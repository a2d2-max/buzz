import assert from "node:assert/strict";
import test from "node:test";

const ROW = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  databaseId: "11111111-2222-4333-8444-555555555555",
  values: { title: "Launch", status: "todo", notes: "keep" },
  docPageId: null,
  createdBy: "a".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  author: "b".repeat(64),
  eventId: "1".repeat(64),
  eventCreatedAt: 1,
  eventKind: 30625,
  deleted: false,
};

const STATUS = {
  id: "status",
  name: "Status",
  type: "status",
  options: {
    choices: [
      { id: "todo", name: "To do", group: "todo" },
      { id: "done", name: "Done", group: "done" },
    ],
  },
};

test("select and status drops create one complete row snapshot", async () => {
  const { buildDatabaseBoardDropValues } = await import(
    "./databaseBoardModel.ts"
  );
  assert.deepEqual(
    buildDatabaseBoardDropValues({
      row: ROW,
      property: STATUS,
      source: "todo",
      target: "done",
    }),
    { title: "Launch", status: "done", notes: "keep" },
  );
  assert.deepEqual(
    buildDatabaseBoardDropValues({
      row: ROW,
      property: STATUS,
      source: "todo",
      target: null,
    }),
    { title: "Launch", status: null, notes: "keep" },
  );
});

test("same-column, unknown, and unsupported drops publish nothing", async () => {
  const { buildDatabaseBoardDropValues } = await import(
    "./databaseBoardModel.ts"
  );
  assert.equal(
    buildDatabaseBoardDropValues({
      row: ROW,
      property: STATUS,
      source: "todo",
      target: "todo",
    }),
    null,
  );
  assert.equal(
    buildDatabaseBoardDropValues({
      row: ROW,
      property: STATUS,
      source: "todo",
      target: "removed",
    }),
    null,
  );
  assert.equal(
    buildDatabaseBoardDropValues({
      row: ROW,
      property: { id: "notes", name: "Notes", type: "text" },
      source: "todo",
      target: "done",
    }),
    null,
  );
});

test("person drops replace the full membership and Empty writes an empty array", async () => {
  const { buildDatabaseBoardDropValues } = await import(
    "./databaseBoardModel.ts"
  );
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const row = { ...ROW, values: { ...ROW.values, people: [alice, bob] } };
  const property = { id: "people", name: "People", type: "person" };
  assert.deepEqual(
    buildDatabaseBoardDropValues({ row, property, source: alice, target: bob }),
    { ...row.values, people: [bob] },
  );
  assert.deepEqual(
    buildDatabaseBoardDropValues({
      row,
      property,
      source: alice,
      target: null,
    }),
    { ...row.values, people: [] },
  );
  assert.equal(
    buildDatabaseBoardDropValues({
      ...{ row, property, source: alice, target: "bad" },
    }),
    null,
  );
  assert.equal(
    buildDatabaseBoardDropValues({
      row,
      property,
      source: alice,
      target: alice,
    }),
    null,
    "dropping the Alice card back on Alice must retain Bob by publishing nothing",
  );
});
