import assert from "node:assert/strict";
import test from "node:test";

const SOURCE_DB = "11111111-2222-4333-8444-555555555555";
const TARGET_DB = "22222222-3333-4444-8555-666666666666";
const SOURCE_ROW = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_SOURCE_ROW = "bbbbbbbb-2222-4222-8222-222222222222";
const TARGET_ROW = "cccccccc-3333-4333-8333-333333333333";
const SECOND_TARGET_ROW = "dddddddd-4444-4444-8444-444444444444";

function schema(id, properties) {
  return {
    id,
    name: id === SOURCE_DB ? "Projects" : "Scores",
    properties,
    views: [],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: (id === SOURCE_DB ? "1" : "2").repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

function row(id, databaseId, values, event = "3") {
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

const relation = {
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
const score = {
  id: "score",
  name: "Score",
  type: "number",
  options: { format: "decimal" },
};

function fixtures() {
  const source = schema(SOURCE_DB, [
    { id: "title", name: "Name", type: "title" },
    relation,
  ]);
  const target = schema(TARGET_DB, [
    { id: "title", name: "Name", type: "title" },
    score,
    mirror,
  ]);
  const rows = new Map([
    [
      SOURCE_ROW,
      row(SOURCE_ROW, SOURCE_DB, { title: "Alpha", targets: [TARGET_ROW] }),
    ],
    [
      OTHER_SOURCE_ROW,
      row(OTHER_SOURCE_ROW, SOURCE_DB, {
        title: "Beta",
        targets: [TARGET_ROW, SECOND_TARGET_ROW],
      }),
    ],
    [TARGET_ROW, row(TARGET_ROW, TARGET_DB, { title: "One", score: 4 })],
    [
      SECOND_TARGET_ROW,
      row(SECOND_TARGET_ROW, TARGET_DB, { title: "Two", score: 6 }),
    ],
  ]);
  return {
    source,
    target,
    rows,
    schemas: new Map([
      [SOURCE_DB, source],
      [TARGET_DB, target],
    ]),
  };
}

test("reciprocal validation and reverse resolution derive one mirror chip per source row", async () => {
  const { createDatabaseComputedResolver, validateDatabaseRelationPair } =
    await import("./databaseComputedResolver.ts");
  const { source, target, rows, schemas } = fixtures();
  assert.equal(
    validateDatabaseRelationPair(source, relation, schemas).ok,
    true,
  );
  assert.equal(validateDatabaseRelationPair(target, mirror, schemas).ok, true);
  const resolver = createDatabaseComputedResolver({
    schemas,
    rows,
    rowHistoryComplete: true,
    nowMs: 1,
  });
  assert.deepEqual(resolver.resolveValue(rows.get(TARGET_ROW), mirror), [
    SOURCE_ROW,
    OTHER_SOURCE_ROW,
  ]);
  assert.deepEqual(resolver.resolveValue(rows.get(SECOND_TARGET_ROW), mirror), [
    OTHER_SOURCE_ROW,
  ]);
});

test("missing reciprocal and truncated reverse history remain explicit without partial values", async () => {
  const { createDatabaseComputedResolver, validateDatabaseRelationPair } =
    await import("./databaseComputedResolver.ts");
  const { source, target, rows, schemas } = fixtures();
  const incompleteTarget = {
    ...target,
    properties: target.properties.filter(({ id }) => id !== mirror.id),
  };
  const incompleteSchemas = new Map([
    [SOURCE_DB, source],
    [TARGET_DB, incompleteTarget],
  ]);
  const pair = validateDatabaseRelationPair(
    source,
    relation,
    incompleteSchemas,
  );
  assert.equal(pair.ok, false);
  assert.equal(pair.error.code, "BROKEN_RELATION");

  const resolver = createDatabaseComputedResolver({
    schemas,
    rows,
    rowHistoryComplete: false,
  });
  const value = resolver.resolveValue(rows.get(TARGET_ROW), mirror);
  assert.equal(value.kind, "computed_error");
  assert.equal(value.code, "SOURCE_INCOMPLETE");
});

test("malformed and oversized authoritative sources make mirrors explicit errors without partial links", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { rows, schemas } = fixtures();
  const malformedRows = new Map(rows);
  malformedRows.set(
    SOURCE_ROW,
    row(SOURCE_ROW, SOURCE_DB, {
      title: "Alpha",
      targets: [TARGET_ROW, "not-a-row-id"],
    }),
  );
  const malformed = createDatabaseComputedResolver({
    schemas,
    rows: malformedRows,
    rowHistoryComplete: true,
  }).resolveValue(malformedRows.get(TARGET_ROW), mirror);
  assert.equal(malformed.code, "BROKEN_RELATION");

  const oversizedRows = new Map([[TARGET_ROW, rows.get(TARGET_ROW)]]);
  for (let index = 0; index < 1_001; index += 1) {
    const suffix = index.toString(16).padStart(12, "0");
    const id = `00000000-0000-4000-8000-${suffix}`;
    oversizedRows.set(
      id,
      row(id, SOURCE_DB, { title: String(index), targets: [TARGET_ROW] }),
    );
  }
  const oversized = createDatabaseComputedResolver({
    schemas,
    rows: oversizedRows,
    rowHistoryComplete: true,
  }).resolveValue(oversizedRows.get(TARGET_ROW), mirror);
  assert.equal(oversized.code, "TOO_COMPLEX");
});

test("complete rollups implement all six null and numeric rules and formula targets", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { source, target, rows } = fixtures();
  const targetWithFormula = {
    ...target,
    properties: [
      ...target.properties,
      {
        id: "double",
        name: "Double",
        type: "formula",
        options: { expression: 'prop("Score") * 2' },
      },
    ],
  };
  const calculations = ["count", "show", "sum", "avg", "min", "max"];
  const sourceWithRollups = {
    ...source,
    properties: [
      ...source.properties,
      ...calculations.map((calculation) => ({
        id: `rollup_${calculation}`,
        name: calculation,
        type: "rollup",
        options: {
          relationPropertyId: relation.id,
          targetPropertyId: calculation === "count" ? "double" : score.id,
          calculation,
        },
      })),
    ],
  };
  const schemas = new Map([
    [SOURCE_DB, sourceWithRollups],
    [TARGET_DB, targetWithFormula],
  ]);
  const resolver = createDatabaseComputedResolver({
    schemas,
    rows,
    rowHistoryComplete: true,
  });
  const sourceRow = {
    ...rows.get(SOURCE_ROW),
    values: {
      ...rows.get(SOURCE_ROW).values,
      targets: [TARGET_ROW, SECOND_TARGET_ROW],
    },
  };
  assert.deepEqual(
    calculations.map((calculation) =>
      resolver.resolveValue(
        sourceRow,
        sourceWithRollups.properties.find(
          ({ id }) => id === `rollup_${calculation}`,
        ),
      ),
    ),
    [2, [4, 6], 10, 5, 4, 6],
  );
});

test("show rollups reject heterogeneous and oversized outputs before exposing partial values", async () => {
  const { calculateDatabaseRollup } = await import(
    "./databaseComputedResolver.ts"
  );
  assert.equal(
    calculateDatabaseRollup("show", [1, "text"]).code,
    "TYPE_MISMATCH",
  );
  assert.equal(
    calculateDatabaseRollup(
      "show",
      Array.from({ length: 1_000 }, () => "x".repeat(1_000)),
    ).code,
    "TOO_COMPLEX",
  );
  assert.deepEqual(calculateDatabaseRollup("show", [null, 1, 2]), [null, 1, 2]);
});

test("computed cycles, rollup-of-rollup, and broken target rows never become partial values", async () => {
  const { createDatabaseComputedResolver } = await import(
    "./databaseComputedResolver.ts"
  );
  const { source, target, rows } = fixtures();
  const formulaA = {
    id: "a",
    name: "A",
    type: "formula",
    options: { expression: 'prop("B")' },
  };
  const formulaB = {
    id: "b",
    name: "B",
    type: "formula",
    options: { expression: 'prop("A")' },
  };
  const cyclic = {
    ...source,
    properties: [...source.properties, formulaA, formulaB],
  };
  const cycleResolver = createDatabaseComputedResolver({
    schemas: new Map([
      [SOURCE_DB, cyclic],
      [TARGET_DB, target],
    ]),
    rows,
    rowHistoryComplete: true,
  });
  assert.equal(
    cycleResolver.resolveValue(rows.get(SOURCE_ROW), formulaA).code,
    "CYCLE",
  );

  const brokenRows = new Map(rows);
  brokenRows.delete(TARGET_ROW);
  const rollup = {
    id: "total",
    name: "Total",
    type: "rollup",
    options: {
      relationPropertyId: relation.id,
      targetPropertyId: score.id,
      calculation: "sum",
    },
  };
  const sourceWithRollup = {
    ...source,
    properties: [...source.properties, rollup],
  };
  const brokenResolver = createDatabaseComputedResolver({
    schemas: new Map([
      [SOURCE_DB, sourceWithRollup],
      [TARGET_DB, target],
    ]),
    rows: brokenRows,
    rowHistoryComplete: true,
  });
  assert.equal(
    brokenResolver.resolveValue(rows.get(SOURCE_ROW), rollup).code,
    "BROKEN_RELATION",
  );
});

test("two schema actions use planned reciprocal ids and mirror chips mutate one source row", async () => {
  const {
    addDatabaseAuthoritativeRelation,
    addDatabaseMirrorRelation,
    setDatabaseMirrorRelationLink,
    setDatabaseRelationLinks,
  } = await import("./databaseRelationCommands.ts");
  const { source, target, rows } = fixtures();
  const plan = {
    sourceDatabaseId: SOURCE_DB,
    targetDatabaseId: TARGET_DB,
    authoritativePropertyId: "planned_source",
    mirrorPropertyId: "planned_mirror",
  };
  const first = addDatabaseAuthoritativeRelation(source, plan, "Scores");
  const authoritative = first.properties.at(-1);
  assert.deepEqual(authoritative.options, {
    databaseId: TARGET_DB,
    direction: "authoritative",
    mirroredPropertyId: "planned_mirror",
  });
  const second = addDatabaseMirrorRelation(target, plan, "Projects");
  assert.deepEqual(second.properties.at(-1).options, {
    databaseId: SOURCE_DB,
    direction: "mirror",
    mirroredPropertyId: "planned_source",
  });

  const sourceRow = rows.get(SOURCE_ROW);
  const replaced = setDatabaseRelationLinks(sourceRow, relation, [
    TARGET_ROW,
    TARGET_ROW,
    SECOND_TARGET_ROW,
  ]);
  assert.deepEqual(replaced.targets, [TARGET_ROW, SECOND_TARGET_ROW]);
  const mirrorIntent = setDatabaseMirrorRelationLink({
    connected: false,
    sourceProperty: relation,
    sourceRow,
    targetRowId: TARGET_ROW,
  });
  assert.equal(mirrorIntent.rowId, SOURCE_ROW);
  assert.equal(mirrorIntent.baseEventId, sourceRow.eventId);
  assert.deepEqual(mirrorIntent.values.targets, []);
});
