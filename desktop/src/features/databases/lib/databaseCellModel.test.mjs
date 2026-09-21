import assert from "node:assert/strict";
import test from "node:test";

const AUTHOR = "a".repeat(64);
const EDITOR = "b".repeat(64);

function row(values = {}) {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    databaseId: "11111111-2222-4333-8444-555555555555",
    values,
    docPageId: null,
    createdBy: AUTHOR,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    author: EDITOR,
    eventId: "e".repeat(64),
    eventCreatedAt: 1_700_000_100,
    eventKind: 30625,
    deleted: false,
  };
}

test("automatic fields derive stable creator and latest signed editor metadata", async () => {
  const model = await import("./databaseCellModel.ts");
  assert.deepEqual(
    model.databaseCellPresentation(
      { id: "created", name: "Created", type: "created_by" },
      row(),
    ),
    { value: AUTHOR, text: AUTHOR, mismatch: false, readOnly: true },
  );
  assert.equal(
    model.databaseCellPresentation(
      { id: "edited", name: "Edited", type: "last_edited_by" },
      row(),
    ).value,
    EDITOR,
  );
  assert.equal(
    model.databaseCellPresentation(
      { id: "missing", name: "Creator", type: "created_by" },
      { ...row(), createdBy: null },
    ).text,
    "Unknown",
  );
});

test("a type mismatch exposes raw data and a recovery state instead of going blank", async () => {
  const { databaseCellPresentation } = await import("./databaseCellModel.ts");
  const presentation = databaseCellPresentation(
    {
      id: "effort",
      name: "Effort",
      type: "number",
      options: { format: "integer" },
    },
    row({ effort: "kept raw" }),
  );
  assert.equal(presentation.text, "kept raw");
  assert.equal(presentation.mismatch, true);
  assert.equal(presentation.readOnly, false);
});

test("first-priority editable values normalize to their wire shapes", async () => {
  const { parseDatabaseCellDraft } = await import("./databaseCellModel.ts");
  const cases = [
    [{ id: "t", name: "T", type: "text" }, "hello", "hello"],
    [
      {
        id: "n",
        name: "N",
        type: "number",
        options: { format: "percent" },
      },
      "20",
      0.2,
    ],
    [{ id: "c", name: "C", type: "checkbox" }, "true", true],
    [{ id: "p", name: "P", type: "person" }, AUTHOR, [AUTHOR]],
    [
      { id: "d", name: "D", type: "date" },
      JSON.stringify({ start: "2026-09-08", includeTime: false }),
      { start: "2026-09-08", includeTime: false },
    ],
  ];
  for (const [property, draft, expected] of cases) {
    assert.deepEqual(parseDatabaseCellDraft(property, draft), expected);
  }
});

test("clearable drafts stay empty and select ids must belong to the schema", async () => {
  const { parseDatabaseCellDraft } = await import("./databaseCellModel.ts");
  const select = {
    id: "s",
    name: "Status",
    type: "select",
    options: { choices: [{ id: "ready", name: "Ready" }] },
  };
  const multi = {
    id: "m",
    name: "Teams",
    type: "multi_select",
    options: { choices: [{ id: "design", name: "Design" }] },
  };
  assert.equal(
    parseDatabaseCellDraft(
      { id: "n", name: "N", type: "number", options: { format: "decimal" } },
      "  ",
    ),
    null,
  );
  assert.equal(parseDatabaseCellDraft(select, ""), null);
  assert.equal(parseDatabaseCellDraft(select, "ready"), "ready");
  assert.throws(
    () => parseDatabaseCellDraft(select, "missing"),
    /available choice/i,
  );
  assert.deepEqual(parseDatabaseCellDraft(multi, "design"), ["design"]);
  assert.throws(
    () => parseDatabaseCellDraft(multi, "design,missing"),
    /available choices/i,
  );
});

test("date drafts validate date-only and timed intervals and compare instants", async () => {
  const { parseDatabaseCellDraft } = await import("./databaseCellModel.ts");
  const property = { id: "d", name: "Date", type: "date" };
  assert.throws(
    () =>
      parseDatabaseCellDraft(
        property,
        JSON.stringify({ start: "not-a-date", includeTime: false }),
      ),
    /valid date/i,
  );
  assert.throws(
    () =>
      parseDatabaseCellDraft(
        property,
        JSON.stringify({ start: "2026-02-30", includeTime: false }),
      ),
    /valid date/i,
  );
  assert.deepEqual(
    parseDatabaseCellDraft(
      property,
      JSON.stringify({
        start: "2026-09-08T23:00:00+09:00",
        end: "2026-09-08T15:00:00+00:00",
        includeTime: true,
      }),
    ),
    {
      start: "2026-09-08T23:00:00+09:00",
      end: "2026-09-08T15:00:00+00:00",
      includeTime: true,
    },
  );
  assert.throws(
    () =>
      parseDatabaseCellDraft(
        property,
        JSON.stringify({ start: "2026-09-08T12:00", includeTime: true }),
      ),
    /timezone/i,
  );
});

test("files compatibility checks file objects rather than any array", async () => {
  const { databaseCellValueMatches } = await import("./databaseCellModel.ts");
  const property = { id: "f", name: "Files", type: "files" };
  assert.equal(databaseCellValueMatches(property, ["legacy-choice"]), false);
  assert.equal(
    databaseCellValueMatches(property, [{ url: "https://example.com" }]),
    true,
  );
});
