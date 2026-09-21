import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDatabaseSchemaEventInput,
  parseDatabaseSchemaContent,
} from "./databaseSchemaCodec.ts";
import {
  buildDatabaseRowEventInput,
  parseDatabaseRowContent,
} from "./databaseRowCodec.ts";
import {
  inferNotionDbSchema,
  NOTION_DB_INFERENCE_ALGORITHM_VERSION,
} from "./inferNotionDbSchema.ts";
import {
  CHOICE_MAX_UTF8_BYTES,
  MAX_CELLS_PER_TABLE,
  MAX_CELL_UTF8_BYTES,
  MAX_COLUMNS,
  MAX_ROWS_PER_TABLE,
  MAX_TABLE_UTF8_BYTES,
  SELECT_MAX_CHOICES,
  SELECT_MAX_DISTINCT_RATIO,
  SELECT_MIN_CHOICES,
  SELECT_MIN_NONEMPTY,
} from "./notionDbInferencePolicy.ts";

const DATABASE_ID = "11111111-2222-8333-8444-555555555555";
const ROW_ID = "aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee";
const DOC_ID = "doc-page-1";

function csv(columns, rows, overrides = {}) {
  return {
    sourcePath: "Workspace/Launch 0123456789abcdef0123456789abcdef_all.csv",
    canonical: true,
    hasMultilineCells: false,
    columns,
    rows,
    ...overrides,
  };
}

function successful(result) {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.code);
  return result;
}

function property(result, index) {
  return successful(result).schema.properties[index];
}

function repeatPair(first, second, count = 8) {
  return Array.from({ length: count }, (_, index) => [
    `Row ${index + 1}`,
    index % 2 === 0 ? first : second,
  ]);
}

function assertUuidV8(value) {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

test("policy constants expose the approved exact work and categorical bounds", () => {
  assert.deepEqual(
    {
      MAX_COLUMNS,
      MAX_ROWS_PER_TABLE,
      MAX_CELLS_PER_TABLE,
      MAX_CELL_UTF8_BYTES,
      MAX_TABLE_UTF8_BYTES,
      SELECT_MIN_NONEMPTY,
      SELECT_MIN_CHOICES,
      SELECT_MAX_CHOICES,
      SELECT_MAX_DISTINCT_RATIO,
      CHOICE_MAX_UTF8_BYTES,
    },
    {
      MAX_COLUMNS: 1_000,
      MAX_ROWS_PER_TABLE: 30_000,
      MAX_CELLS_PER_TABLE: 1_000_000,
      MAX_CELL_UTF8_BYTES: 262_144,
      MAX_TABLE_UTF8_BYTES: 67_108_864,
      SELECT_MIN_NONEMPTY: 8,
      SELECT_MIN_CHOICES: 2,
      SELECT_MAX_CHOICES: 20,
      SELECT_MAX_DISTINCT_RATIO: 0.25,
      CHOICE_MAX_UTF8_BYTES: 128,
    },
  );
});

test("header-only input returns one title, text fallbacks, zero rows, and a safe draft report", () => {
  const input = csv(["", "", "Same", "Same"], []);
  const before = structuredClone(input);
  const first = successful(inferNotionDbSchema(input));
  const second = successful(inferNotionDbSchema(input));

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.equal(
    first.report.algorithmVersion,
    NOTION_DB_INFERENCE_ALGORITHM_VERSION,
  );
  assert.equal(first.report.publishReady, false);
  assert.equal(first.report.timestampSource, "unknown");
  assert.equal(first.report.rowIdentity, "position-derived");
  assert.equal(first.report.incrementalReimportSupported, false);
  assert.deepEqual(first.report.blankColumnIndices, [0, 1]);
  assert.deepEqual(first.report.duplicateColumnIndices, [2, 3]);
  assert.deepEqual(
    first.report.inferredColumns.map(({ columnIndex, type, reason }) => ({
      columnIndex,
      type,
      reason,
    })),
    [
      { columnIndex: 0, type: "title", reason: "title" },
      { columnIndex: 1, type: "text", reason: "no-data" },
      { columnIndex: 2, type: "text", reason: "no-data" },
      { columnIndex: 3, type: "text", reason: "no-data" },
    ],
  );
  assert.deepEqual(
    first.schema.properties.map((candidate) => candidate.name),
    ["Column 1", "Column 2", "Same", "Same"],
  );
  assert.equal(first.schema.properties[0].type, "title");
  assert.equal(
    first.schema.properties.filter((item) => item.type === "title").length,
    1,
  );
  assert.equal(first.rows.length, 0);
  assert.equal(first.schema.createdAt, 0);
  assert.equal(first.schema.updatedAt, 0);
  assertUuidV8(first.schema.id);
  for (const candidate of first.schema.properties) assertUuidV8(candidate.id);
  assertUuidV8(first.schema.views[0].id);
  assert.deepEqual(
    first.schema.views[0].visiblePropertyIds,
    first.schema.properties.map(({ id }) => id),
  );
  const schemaEventInput = buildDatabaseSchemaEventInput(first.schema);
  assert.deepEqual(
    parseDatabaseSchemaContent(JSON.parse(schemaEventInput.content)),
    JSON.parse(schemaEventInput.content),
  );
});

test("explicit identity, Docs mapping, display label, and conversion time stay exact", () => {
  const result = successful(
    inferNotionDbSchema(csv(["Title", "Body"], [["One", "Two"]]), {
      databaseId: DATABASE_ID,
      rowIds: [ROW_ID],
      databaseName: "Exact label",
      conversionTimestampMs: 123_456,
      docPageIds: [DOC_ID],
    }),
  );
  assert.equal(result.schema.id, DATABASE_ID);
  assert.equal(result.schema.name, "Exact label");
  assert.equal(result.schema.createdAt, 123_456);
  assert.equal(result.report.publishReady, true);
  assert.equal(result.report.databaseIdentity, "injected");
  assert.equal(result.report.rowIdentity, "injected");
  assert.equal(result.report.incrementalReimportSupported, false);
  assert.equal(result.report.timestampSource, "conversion-context");
  assert.equal(result.report.displaySource, "conversion-context");
  assert.equal(result.report.docPageMappingCount, 1);
  assert.equal(result.rows[0].id, ROW_ID);
  assert.equal(result.rows[0].databaseId, DATABASE_ID);
  assert.equal(result.rows[0].docPageId, DOC_ID);
  assert.equal(result.rows[0].createdBy, null);
  assert.equal(result.rows[0].createdAt, 123_456);
  const rowEventInput = buildDatabaseRowEventInput(result.rows[0]);
  assert.deepEqual(
    parseDatabaseRowContent(JSON.parse(rowEventInput.content)),
    JSON.parse(rowEventInput.content),
  );
});

test("NFC path identity is stable without rewriting the derived display text", () => {
  const decomposed = "Workspace/Cafe\u0301_all.csv";
  const composed = "Workspace/Café_all.csv";
  const first = successful(
    inferNotionDbSchema(csv(["Title"], [], { sourcePath: decomposed })),
  );
  const second = successful(
    inferNotionDbSchema(csv(["Title"], [], { sourcePath: composed })),
  );
  assert.equal(first.schema.id, second.schema.id);
  assert.equal(first.schema.name, "Cafe\u0301");
  assert.equal(second.schema.name, "Café");
  assert.equal(first.report.databaseIdentity, "source-path-derived");
  assert.equal(JSON.stringify(first.report).includes("Cafe"), false);
});

test("position row ids are deterministic only for the same ordering", () => {
  const original = successful(
    inferNotionDbSchema(csv(["Title"], [["One"], ["Two"]])),
  );
  const repeated = successful(
    inferNotionDbSchema(csv(["Title"], [["One"], ["Two"]])),
  );
  const inserted = successful(
    inferNotionDbSchema(csv(["Title"], [["New"], ["One"], ["Two"]])),
  );
  assert.deepEqual(original.rows, repeated.rows);
  assert.notEqual(original.rows[0].id, inserted.rows[1].id);
  assert.equal(original.report.incrementalReimportSupported, false);
});

test("invalid structure and context fail without partial schema or rows", () => {
  const cases = [
    [csv(["Title"], [], { sourcePath: "" }), "invalid-source-path"],
    [csv(["Title"], [], { canonical: false }), "noncanonical-table"],
    [csv([], []), "invalid-column-count"],
    [csv(["Title", "Body"], [["ragged"]]), "ragged-row"],
    [csv(["Title"], [[1]]), "invalid-cell"],
    [
      csv(["Title"], [], { hasMultilineCells: "false" }),
      "invalid-multiline-flag",
    ],
    [csv(["Title"], [["One"]]), "invalid-context"],
  ];
  for (const [input, code] of cases) {
    const context =
      code === "invalid-context" ? { databaseId: "bad" } : undefined;
    const result = inferNotionDbSchema(input, context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal("schema" in result, false);
    assert.equal("rows" in result, false);
  }

  const duplicate = inferNotionDbSchema(csv(["Title"], [["One"], ["Two"]]), {
    rowIds: [ROW_ID, ROW_ID],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "duplicate-row-id");
  assert.equal("schema" in duplicate, false);

  const mismatched = inferNotionDbSchema(csv(["Title"], [["One"]]), {
    rowIds: [],
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error.code, "invalid-context");

  for (const context of [
    { databaseName: "" },
    { conversionTimestampMs: -1 },
    { conversionTimestampMs: Number.NaN },
    { docPageIds: [] },
    { docPageIds: ["invalid/page"] },
    { extra: true },
  ]) {
    const result = inferNotionDbSchema(csv(["Title"], [["One"]]), context);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid-context");
    assert.equal("rows" in result, false);
  }
});

test("structural work limits reject before inference and keep indexed errors safe", () => {
  const maximumColumns = successful(
    inferNotionDbSchema(
      csv(
        Array.from({ length: MAX_COLUMNS }, (_, index) => `C${index}`),
        [],
      ),
    ),
  );
  assert.equal(maximumColumns.schema.properties.length, MAX_COLUMNS);

  const tooManyColumns = inferNotionDbSchema(
    csv(
      Array.from({ length: MAX_COLUMNS + 1 }, () => ""),
      [],
    ),
  );
  assert.equal(tooManyColumns.ok, false);
  assert.equal(tooManyColumns.error.code, "invalid-column-count");

  const tooManyRows = inferNotionDbSchema(
    csv(
      ["Title"],
      Array.from({ length: MAX_ROWS_PER_TABLE + 1 }, () => [""]),
    ),
  );
  assert.equal(tooManyRows.ok, false);
  assert.equal(tooManyRows.error.code, "too-many-rows");

  const columns = Array.from(
    { length: MAX_COLUMNS },
    (_, index) => `C${index}`,
  );
  const sharedRow = Array.from({ length: MAX_COLUMNS }, () => "");
  const tooManyCells = inferNotionDbSchema(
    csv(
      columns,
      Array.from({ length: 1_001 }, () => sharedRow),
    ),
  );
  assert.equal(tooManyCells.ok, false);
  assert.equal(tooManyCells.error.code, "too-many-cells");

  const sourceTooLarge = inferNotionDbSchema(
    csv(["Title"], [], { sourcePath: "s".repeat(MAX_CELL_UTF8_BYTES + 1) }),
  );
  assert.equal(sourceTooLarge.ok, false);
  assert.equal(sourceTooLarge.error.code, "source-path-too-large");

  const headerTooLarge = inferNotionDbSchema(
    csv(["h".repeat(MAX_CELL_UTF8_BYTES + 1)], []),
  );
  assert.equal(headerTooLarge.ok, false);
  assert.equal(headerTooLarge.error.code, "header-too-large");
  assert.equal(headerTooLarge.error.columnIndex, 0);
});

test("the cumulative byte limit includes path, headers, and every cell", () => {
  const boundedCell = "x".repeat(MAX_CELL_UTF8_BYTES);
  const result = inferNotionDbSchema(
    csv(
      Array.from({ length: 257 }, (_, index) => `C${index}`),
      [Array.from({ length: 257 }, () => boundedCell)],
    ),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "table-too-large");
  assert.equal("schema" in result, false);
  assert.equal("rows" in result, false);
});

test("strict dates preserve mode and offset while invalid or mixed shapes stay text", () => {
  const valid = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Day", "Instant"],
        [
          ["One", "2026-09-09", "2026-09-09T09:30:00.123+09:00"],
          ["Two", "", ""],
          ["Three", "2026-09-10", "2026-09-10T00:30Z"],
        ],
      ),
    ),
  );
  assert.equal(valid.schema.properties[1].type, "date");
  assert.equal(valid.schema.properties[2].type, "date");
  assert.deepEqual(valid.rows[0].values[valid.schema.properties[1].id], {
    start: "2026-09-09",
    includeTime: false,
  });
  assert.deepEqual(valid.rows[0].values[valid.schema.properties[2].id], {
    start: "2026-09-09T09:30:00.123+09:00",
    includeTime: true,
  });
  assert.equal(valid.rows[1].values[valid.schema.properties[1].id], null);

  const mixed = inferNotionDbSchema(
    csv(
      ["Title", "When"],
      [
        ["One", "2026-09-09"],
        ["Two", "2026-09-09T00:00Z"],
      ],
    ),
  );
  assert.equal(property(mixed, 1).type, "text");
  assert.equal(
    successful(mixed).report.inferredColumns[1].reason,
    "mixed-date-mode",
  );

  const invalid = inferNotionDbSchema(
    csv(["Title", "When"], repeatPair("2026-02-30", "2026-13-01")),
  );
  assert.equal(property(invalid, 1).type, "text");
  assert.equal(
    successful(invalid).report.inferredColumns[1].reason,
    "recognizable-scalar-rejected",
  );
});

test("explicit rejected date and URL shapes cannot fall through to select", () => {
  const rejectedPairs = [
    ["2026-09-09 09:30", "2026-09-10 10:30"],
    ["2026-09-09 - 2026-09-10", "2026-10-01 - 2026-10-02"],
    ["2026-09-09..2026-09-10", "2026-10-01..2026-10-02"],
    ["//example.test/a", "//example.test/b"],
    ["/alpha", "/beta"],
    ["http:/alpha", "https:/beta"],
    ["http:alpha", "https:beta"],
    ["file:///alpha", "file:///beta"],
    ["javascript:alpha", "javascript:beta"],
  ];
  for (const pair of rejectedPairs) {
    const result = successful(
      inferNotionDbSchema(csv(["Title", "Candidate"], repeatPair(...pair))),
    );
    assert.equal(result.schema.properties[1].type, "text", pair.join("|"));
    assert.equal(
      result.report.inferredColumns[1].reason,
      "recognizable-scalar-rejected",
      pair.join("|"),
    );
  }

  const ordinary = successful(
    inferNotionDbSchema(
      csv(["Title", "Candidate"], repeatPair("http status", "Alpha/Beta")),
    ),
  );
  assert.equal(ordinary.schema.properties[1].type, "select");
});

test("canonical finite decimals infer numbers without losing source precision", () => {
  const numeric = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Amount"],
        [
          ["One", "0.1"],
          ["Two", "1.00"],
          ["Three", ""],
        ],
      ),
    ),
  );
  assert.equal(numeric.schema.properties[1].type, "number");
  assert.equal(numeric.schema.properties[1].options.format, "decimal");
  const id = numeric.schema.properties[1].id;
  assert.deepEqual(
    numeric.rows.map((row) => row.values[id]),
    [0.1, 1, null],
  );

  for (const source of ["9007199254740993", "1.234567890123456789", "-0"]) {
    const fallback = successful(
      inferNotionDbSchema(csv(["Title", "Amount"], [["One", source]])),
    );
    assert.equal(fallback.schema.properties[1].type, "text", source);
    assert.equal(
      fallback.report.inferredColumns[1].reason,
      "precision-loss",
      source,
    );
    assert.equal(
      fallback.rows[0].values[fallback.schema.properties[1].id],
      source,
    );
  }

  const integer = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Amount"],
        [
          ["One", "1"],
          ["Two", "-2"],
        ],
      ),
    ),
  );
  assert.equal(integer.schema.properties[1].type, "number");
  assert.equal(integer.schema.properties[1].options.format, "integer");

  for (const source of [
    "+1",
    "01",
    "1e3",
    "1,000",
    "50%",
    "NaN",
    ".5",
    "1.",
    " 1",
  ]) {
    const fallback = successful(
      inferNotionDbSchema(csv(["Title", "Amount"], [["One", source]])),
    );
    assert.equal(fallback.schema.properties[1].type, "text", source);
    assert.equal(
      fallback.report.inferredColumns[1].reason,
      "recognizable-scalar-rejected",
      source,
    );
  }
});

test("checkbox and safe URL inference require one exact strict family", () => {
  const strict = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Done", "Link"],
        [
          ["One", "Yes", "https://example.test/a"],
          ["Two", "No", "http://example.test/b"],
          ["Three", "", ""],
        ],
      ),
    ),
  );
  assert.equal(strict.schema.properties[1].type, "checkbox");
  assert.equal(strict.schema.properties[2].type, "url");
  assert.equal(strict.rows[0].values[strict.schema.properties[1].id], true);
  assert.equal(strict.rows[1].values[strict.schema.properties[1].id], false);
  assert.equal(strict.rows[2].values[strict.schema.properties[2].id], null);

  const mixedCheckbox = successful(
    inferNotionDbSchema(csv(["Title", "Done"], repeatPair("Yes", "☑"))),
  );
  assert.equal(mixedCheckbox.schema.properties[1].type, "text");
  assert.equal(
    mixedCheckbox.report.inferredColumns[1].reason,
    "mixed-checkbox-notation",
  );

  for (const values of [
    ["TRUE", "FALSE"],
    ["http:// bad.test", "https:// bad.test"],
  ]) {
    const fallback = successful(
      inferNotionDbSchema(csv(["Title", "Value"], repeatPair(...values))),
    );
    assert.equal(fallback.schema.properties[1].type, "text");
    assert.equal(
      fallback.report.inferredColumns[1].reason,
      "recognizable-scalar-rejected",
    );
  }

  for (const source of [
    "HTTPS://example.test",
    "https://user:secret@example.test",
    "https://example.test/ bad",
    "https://",
  ]) {
    const fallback = successful(
      inferNotionDbSchema(csv(["Title", "Link"], [["One", source]])),
    );
    assert.equal(fallback.schema.properties[1].type, "text", source);
    assert.equal(
      fallback.report.inferredColumns[1].reason,
      "recognizable-scalar-rejected",
      source,
    );
  }
});

test("accepted scalar shapes mixed with ordinary text cannot become categories", () => {
  for (const values of [
    ["1", "Alpha"],
    ["2026-09-09", "Alpha"],
    ["Yes", "Alpha"],
    ["https://example.test", "Alpha"],
  ]) {
    const result = successful(
      inferNotionDbSchema(csv(["Title", "Mixed"], repeatPair(...values))),
    );
    assert.equal(result.schema.properties[1].type, "text");
    assert.equal(result.report.inferredColumns[1].reason, "mixed-scalar");
  }

  for (const values of [
    ["01", "Alpha"],
    ["http:// bad.test", "Alpha"],
  ]) {
    const result = successful(
      inferNotionDbSchema(csv(["Title", "Mixed"], repeatPair(...values))),
    );
    assert.equal(result.schema.properties[1].type, "text");
    assert.equal(
      result.report.inferredColumns[1].reason,
      "recognizable-scalar-rejected",
    );
  }
});

test("select inference applies recurrence, cardinality, exact labels, and stable choice ids", () => {
  const accepted = successful(
    inferNotionDbSchema(csv(["Title", "Team"], repeatPair("Alpha", "Beta"))),
  );
  const selected = accepted.schema.properties[1];
  assert.equal(selected.type, "select");
  assert.deepEqual(
    selected.options.choices.map(({ name }) => name),
    ["Alpha", "Beta"],
  );
  for (const choice of selected.options.choices) assertUuidV8(choice.id);
  assert.equal(
    accepted.rows[0].values[selected.id],
    selected.options.choices[0].id,
  );
  assert.deepEqual(
    successful(
      inferNotionDbSchema(csv(["Title", "Team"], repeatPair("Alpha", "Beta"))),
    ).schema,
    accepted.schema,
  );

  const tooFew = successful(
    inferNotionDbSchema(csv(["Title", "Team"], repeatPair("Alpha", "Beta", 7))),
  );
  assert.equal(tooFew.schema.properties[1].type, "text");
  assert.equal(tooFew.report.inferredColumns[1].reason, "too-few-observations");

  const oneChoice = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Team"],
        Array.from({ length: SELECT_MIN_NONEMPTY }, (_, index) => [
          `Row ${index}`,
          "Alpha",
        ]),
      ),
    ),
  );
  assert.equal(oneChoice.schema.properties[1].type, "text");
  assert.equal(oneChoice.report.inferredColumns[1].reason, "too-few-choices");

  const caseSensitive = successful(
    inferNotionDbSchema(csv(["Title", "Team"], repeatPair("Alpha", "alpha"))),
  );
  assert.equal(caseSensitive.schema.properties[1].type, "select");
  assert.deepEqual(
    caseSensitive.schema.properties[1].options.choices.map(({ name }) => name),
    ["Alpha", "alpha"],
  );

  const highCardinality = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Team"],
        Array.from({ length: 8 }, (_, index) => [
          `Row ${index}`,
          `Team ${index % 3}`,
        ]),
      ),
    ),
  );
  assert.equal(highCardinality.schema.properties[1].type, "text");
  assert.equal(
    highCardinality.report.inferredColumns[1].reason,
    "high-cardinality",
  );

  const twentyLabels = Array.from(
    { length: SELECT_MAX_CHOICES },
    (_, index) => `Label ${index}`,
  );
  const maxAccepted = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Team"],
        twentyLabels.flatMap((label, index) =>
          Array.from({ length: 4 }, (_, repetition) => [
            `Row ${index}-${repetition}`,
            label,
          ]),
        ),
      ),
    ),
  );
  assert.equal(maxAccepted.schema.properties[1].type, "select");
  assert.equal(maxAccepted.schema.properties[1].options.choices.length, 20);

  const twentyOneLabels = [...twentyLabels, "Label 20"];
  const aboveMax = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Team"],
        twentyOneLabels.flatMap((label, index) =>
          Array.from({ length: 4 }, (_, repetition) => [
            `Row ${index}-${repetition}`,
            label,
          ]),
        ),
      ),
    ),
  );
  assert.equal(aboveMax.schema.properties[1].type, "text");
  assert.equal(aboveMax.report.inferredColumns[1].reason, "high-cardinality");

  const label128 = "a".repeat(CHOICE_MAX_UTF8_BYTES);
  const label127 = `${"b".repeat(CHOICE_MAX_UTF8_BYTES - 1)}c`;
  const byteBoundary = successful(
    inferNotionDbSchema(csv(["Title", "Team"], repeatPair(label128, label127))),
  );
  assert.equal(byteBoundary.schema.properties[1].type, "select");
  const overByteBoundary = successful(
    inferNotionDbSchema(
      csv(["Title", "Team"], repeatPair(`${label128}a`, label127)),
    ),
  );
  assert.equal(overByteBoundary.schema.properties[1].type, "text");
  assert.equal(
    overByteBoundary.report.inferredColumns[1].reason,
    "unsafe-choice",
  );
});

test("multi-select requires exact delimiter, singleton evidence, recurrence, and no repeated token", () => {
  const acceptedRows = [
    ["One", "Alpha"],
    ["Two", "Beta"],
    ...Array.from({ length: 6 }, (_, index) => [
      `Both ${index}`,
      "Alpha, Beta",
    ]),
  ];
  const accepted = successful(
    inferNotionDbSchema(csv(["Title", "Tags"], acceptedRows)),
  );
  const tags = accepted.schema.properties[1];
  assert.equal(tags.type, "multi_select");
  assert.deepEqual(
    tags.options.choices.map(({ name }) => name),
    ["Alpha", "Beta"],
  );
  assert.deepEqual(
    accepted.rows[2].values[tags.id],
    tags.options.choices.map(({ id }) => id),
  );

  const belowObservationMinimum = successful(
    inferNotionDbSchema(csv(["Title", "Tags"], acceptedRows.slice(0, 7))),
  );
  assert.equal(belowObservationMinimum.schema.properties[1].type, "text");
  assert.equal(
    belowObservationMinimum.report.inferredColumns[1].reason,
    "too-few-observations",
  );

  for (const values of [
    ["Alpha,Beta", "Alpha,Beta"],
    ["Alpha, Beta", "Alpha, Beta"],
    ["Alpha", "Alpha, Alpha"],
    ["Alpha", "Alpha, Missing"],
  ]) {
    const fallback = successful(
      inferNotionDbSchema(csv(["Title", "Tags"], repeatPair(...values))),
    );
    assert.equal(fallback.schema.properties[1].type, "text", values.join("|"));
  }

  const withEmpty = successful(
    inferNotionDbSchema(
      csv(["Title", "Tags"], [...acceptedRows, ["Empty", ""]]),
    ),
  );
  assert.equal(withEmpty.schema.properties[1].type, "multi_select");
  assert.deepEqual(
    withEmpty.rows.at(-1).values[withEmpty.schema.properties[1].id],
    [],
  );

  const labels = Array.from({ length: 20 }, (_, index) => `Tag ${index}`);
  const maxTokens = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Tags"],
        [
          ...labels.map((label, index) => [`Single ${index}`, label]),
          ...Array.from({ length: 3 }, (_, index) => [
            `All ${index}`,
            labels.join(", "),
          ]),
        ],
      ),
    ),
  );
  assert.equal(maxTokens.schema.properties[1].type, "multi_select");

  const tooManyTokens = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Tags"],
        [
          ...[...labels, "Tag 20"].map((label, index) => [
            `Single ${index}`,
            label,
          ]),
          ["All", [...labels, "Tag 20"].join(", ")],
          ...Array.from({ length: 5 }, (_, index) => [
            "Repeat",
            `Tag ${index}`,
          ]),
        ],
      ),
    ),
  );
  assert.equal(tooManyTokens.schema.properties[1].type, "text");
  assert.equal(tooManyTokens.report.inferredColumns[1].reason, "unsafe-choice");

  const scalarTokens = successful(
    inferNotionDbSchema(
      csv(
        ["Title", "Tags"],
        [
          ["One", "01"],
          ["Two", "02"],
          ...Array.from({ length: 6 }, (_, index) => [
            `Both ${index}`,
            "01, 02",
          ]),
        ],
      ),
    ),
  );
  assert.equal(scalarTokens.schema.properties[1].type, "text");
  assert.equal(
    scalarTokens.report.inferredColumns[1].reason,
    "recognizable-scalar-rejected",
  );
});

test("production codec and event size failures reject the complete conversion", () => {
  const rowTooLarge = inferNotionDbSchema(
    csv(["Title", "Body"], [["x".repeat(140_000), "y".repeat(140_000)]]),
  );
  assert.equal(rowTooLarge.ok, false);
  assert.equal(rowTooLarge.error.code, "row-content-too-large");
  assert.equal("schema" in rowTooLarge, false);
  assert.equal("rows" in rowTooLarge, false);

  const schemaTooLarge = inferNotionDbSchema(
    csv(
      Array.from({ length: MAX_COLUMNS }, (_, index) =>
        `${index}-`.padEnd(320, "h"),
      ),
      [],
    ),
  );
  assert.equal(schemaTooLarge.ok, false);
  assert.equal(schemaTooLarge.error.code, "schema-content-too-large");
  assert.equal("schema" in schemaTooLarge, false);

  const cellTooLarge = inferNotionDbSchema(
    csv(["Title"], [["한".repeat(Math.ceil((MAX_CELL_UTF8_BYTES + 1) / 3))]]),
  );
  assert.equal(cellTooLarge.ok, false);
  assert.equal(cellTooLarge.error.code, "cell-too-large");
  assert.equal(cellTooLarge.error.rowIndex, 0);
  assert.equal(cellTooLarge.error.columnIndex, 0);
});

test("reports contain only safe aggregate keys and never source strings", () => {
  const privateStrings = [
    "Secret/Path_all.csv",
    "Private Header",
    "Private Value",
  ];
  const result = successful(
    inferNotionDbSchema(
      csv(["Title", privateStrings[1]], [["Row", privateStrings[2]]], {
        sourcePath: privateStrings[0],
      }),
    ),
  );
  const serialized = JSON.stringify(result.report);
  for (const secret of privateStrings)
    assert.doesNotMatch(serialized, new RegExp(secret));

  const forbiddenKeys = new Set([
    "sourcePath",
    "name",
    "header",
    "value",
    "choice",
    "url",
    "content",
    "markdown",
  ]);
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, value] of Object.entries(candidate)) {
      assert.equal(forbiddenKeys.has(key), false, key);
      visit(value);
    }
  };
  visit(result.report);
});
