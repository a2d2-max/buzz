import assert from "node:assert/strict";
import test from "node:test";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "aaaaaaaa-1111-4111-8111-111111111111";

const properties = [
  { id: "title", name: "Name", type: "title" },
  {
    id: "effort",
    name: "Effort",
    type: "number",
    options: { format: "decimal" },
  },
  { id: "done", name: "Done", type: "checkbox" },
  { id: "due", name: "Due", type: "date" },
];

async function evaluate(source, values = {}, nowMs = Date.UTC(2026, 8, 9, 4)) {
  const { evaluateDatabaseFormula } = await import(
    "./databaseFormulaEvaluator.ts"
  );
  return evaluateDatabaseFormula({
    source,
    properties,
    rowId: ROW_ID,
    nowMs,
    readProperty: (id) => values[id] ?? null,
  });
}

test("formula compiler binds exact prop ids and lazily selects if, ifs, and ternary branches", async () => {
  assert.deepEqual(
    await evaluate('if(prop("Done"), prop("Effort") * 2, divide(1, 0))', {
      done: true,
      effort: 3,
    }),
    { ok: true, value: 6, usesNow: false },
  );
  assert.deepEqual(
    await evaluate('if(prop("Done"), divide(1, 0), 7)', { done: false }),
    { ok: true, value: 7, usesNow: false },
  );
  assert.deepEqual(await evaluate("ifs(false, divide(1, 0), true, 8, 9)"), {
    ok: true,
    value: 8,
    usesNow: false,
  });
  assert.deepEqual(await evaluate("false ? divide(1, 0) : 11"), {
    ok: true,
    value: 11,
    usesNow: false,
  });
});

test("conditions and logical operators require booleans while remaining lazy", async () => {
  for (const source of [
    "if(1, 2, 3)",
    "1 ? 2 : 3",
    "1 and true",
    "false or 1",
    "not 0",
  ]) {
    const result = await evaluate(source);
    assert.equal(result.ok, false, source);
    assert.equal(result.error.code, "TYPE_MISMATCH", source);
  }
  assert.deepEqual(await evaluate("false and divide(1, 0) == 0"), {
    ok: true,
    value: false,
    usesNow: false,
  });
  assert.deepEqual(await evaluate("true or divide(1, 0) == 0"), {
    ok: true,
    value: true,
    usesNow: false,
  });
});

test("comparison and arithmetic adapters reject JavaScript coercion and non-finite results", async () => {
  for (const source of [
    '"2" > 1',
    "1 == true",
    '"2" + 1',
    "divide(1, 0)",
    "sqrt(-1)",
  ]) {
    const result = await evaluate(source);
    assert.equal(result.ok, false, source);
    assert.ok(
      ["TYPE_MISMATCH", "DIVIDE_BY_ZERO", "NON_FINITE"].includes(
        result.error.code,
      ),
      source,
    );
  }
  assert.deepEqual(await evaluate("2 ^ 3 + mod(7, 4)"), {
    ok: true,
    value: 11,
    usesNow: false,
  });
});

test("power binds before unary signs, remains right associative, and accepts signed exponents", async () => {
  for (const [source, expected] of [
    ["-2 ^ 2", -4],
    ["(-2) ^ 2", 4],
    ["2 ^ -3", 0.125],
    ["2 ^ 3 ^ 2", 512],
  ]) {
    assert.deepEqual(await evaluate(source), {
      ok: true,
      value: expected,
      usesNow: false,
    });
  }
});

test("date comparison is strict by mode and timed instants compare by epoch", async () => {
  assert.deepEqual(
    await evaluate(
      'parseDate("2026-09-09T09:00:00+09:00") == parseDate("2026-09-09T00:00:00Z")',
    ),
    { ok: true, value: true, usesNow: false },
  );
  const mixed = await evaluate(
    'parseDate("2026-09-09") < parseDate("2026-09-10T00:00:00Z")',
  );
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error.code, "TYPE_MISMATCH");
  const invalid = await evaluate('parseDate("2026-02-30")');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "TYPE_MISMATCH");
  assert.deepEqual(
    await evaluate(
      'dateRange(parseDate("2026-09-09"), parseDate("2026-09-10")) == dateRange(parseDate("2026-09-09"), parseDate("2026-09-11"))',
    ),
    { ok: true, value: false, usesNow: false },
  );
});

test("essential text, list, numeric, identity, and date adapters use bounded strict values", async () => {
  assert.deepEqual(await evaluate('upper(trim("  buzz "))'), {
    ok: true,
    value: "BUZZ",
    usesNow: false,
  });
  assert.deepEqual(await evaluate('join(slice(["a", "b", "c"], 1, 3), "-")'), {
    ok: true,
    value: "b-c",
    usesNow: false,
  });
  assert.deepEqual(await evaluate("round(mean([1, null, 2, 3]), 1)"), {
    ok: true,
    value: 2,
    usesNow: false,
  });
  assert.deepEqual(await evaluate("id()"), {
    ok: true,
    value: ROW_ID,
    usesNow: false,
  });
  const date = await evaluate(
    'dateBetween(dateAdd(parseDate("2026-01-31"), 1, "month"), parseDate("2026-01-31"), "days")',
  );
  assert.deepEqual(date, { ok: true, value: 28, usesNow: false });
  const now = await evaluate("timestamp(now()) == timestamp(now())");
  assert.deepEqual(now, { ok: true, value: true, usesNow: true });
});

test("compiler exposes static result types and marks both clock functions", async () => {
  const { compileDatabaseFormula } = await import(
    "./databaseFormulaCompiler.ts"
  );
  for (const [source, resultType, usesNow] of [
    ['prop("Effort") * 2', "number", false],
    ['prop("Done")', "boolean", false],
    ['prop("Due")', "date", false],
    ['prop("Name")', "string", false],
    ["[1, 2]", "list", false],
    ["now()", "date", true],
    ["today()", "date", true],
  ]) {
    const compiled = compileDatabaseFormula(source, properties);
    assert.equal(compiled.ok, true, source);
    assert.equal(compiled.compilation.resultType, resultType, source);
    assert.equal(compiled.compilation.usesNow, usesNow, source);
  }
});

test("date arithmetic preserves timed offsets and promotes date-only subday results", async () => {
  assert.deepEqual(
    await evaluate(
      'dateAdd(dateRange(parseDate("2026-09-09T09:30:00.123+09:00"), parseDate("2026-09-10T10:31:02.456+09:00")), 1, "day")',
    ),
    {
      ok: true,
      value: {
        start: "2026-09-10T09:30:00.123+09:00",
        end: "2026-09-11T10:31:02.456+09:00",
        includeTime: true,
      },
      usesNow: false,
    },
  );
  assert.deepEqual(
    await evaluate('dateAdd(parseDate("2026-09-09T09:30:00+09:00"), 1, "day")'),
    {
      ok: true,
      value: { start: "2026-09-10T09:30:00.000+09:00", includeTime: true },
      usesNow: false,
    },
  );
  assert.deepEqual(
    await evaluate('dateAdd(parseDate("2026-09-09"), 1, "hour")'),
    {
      ok: true,
      value: { start: "2026-09-09T01:00:00.000Z", includeTime: true },
      usesNow: false,
    },
  );
  assert.deepEqual(
    await evaluate('dateSubtract(parseDate("2026-09-09"), 1, "minute")'),
    {
      ok: true,
      value: { start: "2026-09-08T23:59:00.000Z", includeTime: true },
      usesNow: false,
    },
  );
});

test("aggregate and concat functions require an argument while preserving empty-list identities", async () => {
  for (const source of ["sum()", "min()", "max()", "mean()", "concat()"]) {
    const result = await evaluate(source);
    assert.equal(result.ok, false, source);
    assert.equal(result.error.code, "TYPE_MISMATCH", source);
  }
  assert.deepEqual(await evaluate("sum([])"), {
    ok: true,
    value: 0,
    usesNow: false,
  });
  for (const source of ["min([])", "max([])", "mean([])"]) {
    assert.deepEqual(await evaluate(source), {
      ok: true,
      value: null,
      usesNow: false,
    });
  }
  assert.deepEqual(await evaluate("concat([])"), {
    ok: true,
    value: [],
    usesNow: false,
  });
});

test("growing text and list adapters reject bounded outputs before joining or flattening", async () => {
  const { evaluateDatabaseFormula } = await import(
    "./databaseFormulaEvaluator.ts"
  );
  const extended = [
    ...properties,
    {
      id: "tags",
      name: "Tags",
      type: "multi_select",
      options: { choices: [] },
    },
    {
      id: "other",
      name: "Other",
      type: "multi_select",
      options: { choices: [] },
    },
    { id: "long", name: "Long", type: "text" },
  ];
  const run = (source, values) =>
    evaluateDatabaseFormula({
      source,
      properties: extended,
      rowId: ROW_ID,
      nowMs: 1,
      readProperty: (id) => values[id] ?? null,
    });
  const separator = "x".repeat(3_900);
  const joined = run(`join(prop("Tags"), "${separator}")`, {
    tags: Array.from({ length: 1_000 }, () => "a"),
  });
  assert.equal(joined.ok, false);
  assert.equal(joined.error.code, "TOO_COMPLEX");
  for (const result of [
    run('concat(prop("Tags"), prop("Other"))', {
      tags: Array.from({ length: 600 }, () => "a"),
      other: Array.from({ length: 600 }, () => "b"),
    }),
    run('split(prop("Long"), "")', { long: "a".repeat(1_001) }),
    run('format(prop("Tags"))', {
      tags: Array.from({ length: 1_000 }, () => "x".repeat(20)),
    }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TOO_COMPLEX");
  }
});

test("numeric aggregation checks its visit bound before flattening repeated property lists", async () => {
  const { evaluateDatabaseFormula } = await import(
    "./databaseFormulaEvaluator.ts"
  );
  const many = {
    id: "many",
    name: "Many",
    type: "multi_select",
    options: { choices: [] },
  };
  const result = evaluateDatabaseFormula({
    source: `sum(${Array.from({ length: 80 }, () => 'prop("Many")').join(",")})`,
    properties: [...properties, many],
    rowId: ROW_ID,
    nowMs: 1,
    readProperty: () => Array.from({ length: 1_000 }, (_, index) => index),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOO_COMPLEX");
});

test("compiler rejects dynamic, unknown, ambiguous, unsupported, and over-bounded sources with original offsets", async () => {
  const { compileDatabaseFormula } = await import(
    "./databaseFormulaCompiler.ts"
  );
  const dynamic = compileDatabaseFormula('prop(lower("Name"))', properties);
  assert.equal(dynamic.ok, false);
  assert.equal(dynamic.error.code, "SYNTAX");
  assert.match(dynamic.error.detail, /at 0/u);
  const unknown = compileDatabaseFormula('prop("Missing")', properties);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "UNKNOWN_PROPERTY");
  const ambiguous = compileDatabaseFormula('prop("Name")', [
    ...properties,
    { id: "other", name: "Name", type: "text" },
  ]);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "AMBIGUOUS_PROPERTY");
  const unsupported = compileDatabaseFormula("random()", properties);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED_FUNCTION");
  const tooLong = compileDatabaseFormula(`"${"x".repeat(4_097)}"`, properties);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error.code, "TOO_COMPLEX");
  const validEmptyDatabaseFormula = compileDatabaseFormula(
    'prop("Effort") * 2',
    properties,
  );
  assert.equal(validEmptyDatabaseFormula.ok, true);
  const obviousTypeError = compileDatabaseFormula(
    'prop("Name") * 2',
    properties,
  );
  assert.equal(obviousTypeError.ok, false);
  assert.equal(obviousTypeError.error.code, "TYPE_MISMATCH");
  const wrongArity = compileDatabaseFormula("add(1)", properties);
  assert.equal(wrongArity.ok, false);
  assert.equal(wrongArity.error.code, "TYPE_MISMATCH");
  void DATABASE_ID;
});
