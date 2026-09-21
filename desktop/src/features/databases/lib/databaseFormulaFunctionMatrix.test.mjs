import assert from "node:assert/strict";
import test from "node:test";

const ROW_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 8, 9, 4, 5, 6);
const properties = [
  { id: "title", name: "Name", type: "title" },
  { id: "empty", name: "Empty", type: "text" },
];

async function run(source, values = {}) {
  const { evaluateDatabaseFormula } = await import(
    "./databaseFormulaEvaluator.ts"
  );
  return evaluateDatabaseFormula({
    source,
    properties,
    rowId: ROW_ID,
    nowMs: NOW,
    readProperty: (id) => values[id] ?? null,
  });
}

const cases = [
  ["empty", "empty(null)", true, "empty()", null],
  ["length", 'length("buzz")', 4, "length()", "length(null)"],
  [
    "substring",
    'substring("buzz", 1, 3)',
    "uz",
    "substring()",
    'substring("x", "a")',
  ],
  ["contains", 'contains("buzz", "uz")', true, "contains()", "contains(1, 1)"],
  ["lower", 'lower("BUZZ")', "buzz", "lower()", "lower(1)"],
  ["upper", 'upper("buzz")', "BUZZ", "upper()", "upper(1)"],
  ["trim", 'trim(" buzz ")', "buzz", "trim()", "trim(1)"],
  ["format", "format(null)", "", "format()", null],
  ["add", "add(2, 3)", 5, "add(2)", 'add("2", 3)'],
  ["subtract", "subtract(5, 3)", 2, "subtract(5)", "subtract(null, 3)"],
  ["multiply", "multiply(2, 3)", 6, "multiply(2)", "multiply(true, 3)"],
  ["divide", "divide(6, 3)", 2, "divide(6)", "divide(6, null)"],
  ["mod", "mod(7, 4)", 3, "mod(7)", "mod(7, false)"],
  ["pow", "pow(2, 3)", 8, "pow(2)", 'pow(2, "3")'],
  ["min", "min([3, null, 1])", 1, "min()", 'min([1, "2"])'],
  ["max", "max([3, null, 1])", 3, "max()", "max([1, false])"],
  ["sum", "sum([3, null, 1])", 4, "sum()", "sum([1, true])"],
  ["mean", "mean([3, null, 1])", 2, "mean()", 'mean([1, "3"])'],
  ["abs", "abs(-3)", 3, "abs()", 'abs("3")'],
  ["round", "round(1.25, 1)", 1.3, "round()", "round(1, 20)"],
  ["ceil", "ceil(1.2)", 2, "ceil()", "ceil(null)"],
  ["floor", "floor(1.8)", 1, "floor()", "floor(true)"],
  ["sqrt", "sqrt(9)", 3, "sqrt()", 'sqrt("9")'],
  ["pi", "pi()", Math.PI, "pi(1)", null],
  ["toNumber", 'toNumber("2.5")', 2.5, "toNumber()", "toNumber(null)"],
  ["at", 'at(["a", "b"], 1)', "b", "at([])", 'at(["a"], 1.2)'],
  ["first", 'first(["a", "b"])', "a", "first()", 'first("a")'],
  ["last", 'last(["a", "b"])', "b", "last()", "last(null)"],
  ["slice", "slice([1, 2, 3], 1, 3)", [2, 3], "slice([])", 'slice([1], "0")'],
  ["concat", 'concat(["a"], ["b"])', ["a", "b"], "concat()", 'concat("a")'],
  ["join", 'join(["a", "b"], "-")', "a-b", "join([])", 'join([1], ",")'],
  ["split", 'split("a,b", ",")', ["a", "b"], "split()", "split(1, 2)"],
  [
    "includes",
    'includes(["a"], "a")',
    true,
    "includes([])",
    'includes("a", "a")',
  ],
  ["id", "id()", ROW_ID, "id(1)", null],
  [
    "parseDate",
    'parseDate("2026-09-09")',
    { start: "2026-09-09", includeTime: false },
    "parseDate()",
    'parseDate("09/09/2026")',
  ],
  [
    "dateRange",
    'dateRange(parseDate("2026-09-09"), parseDate("2026-09-10"))',
    { start: "2026-09-09", end: "2026-09-10", includeTime: false },
    "dateRange()",
    'dateRange(parseDate("2026-09-10"), parseDate("2026-09-09"))',
  ],
  [
    "dateStart",
    'dateStart(dateRange(parseDate("2026-09-09"), parseDate("2026-09-10")))',
    { start: "2026-09-09", includeTime: false },
    "dateStart()",
    "dateStart(null)",
  ],
  [
    "dateEnd",
    'dateEnd(dateRange(parseDate("2026-09-09"), parseDate("2026-09-10")))',
    { start: "2026-09-10", includeTime: false },
    "dateEnd()",
    "dateEnd(null)",
  ],
  [
    "timestamp",
    'timestamp(parseDate("1970-01-02"))',
    86_400_000,
    "timestamp()",
    "timestamp(null)",
  ],
  [
    "now",
    "now()",
    { start: "2026-09-09T04:05:06.000Z", includeTime: true },
    "now(1)",
    null,
  ],
  [
    "today",
    "today()",
    { start: "2026-09-09", includeTime: false },
    "today(1)",
    null,
  ],
  [
    "dateAdd",
    'dateAdd(parseDate("2026-01-31"), 1, "month")',
    { start: "2026-02-28", includeTime: false },
    "dateAdd()",
    'dateAdd(parseDate("2026-01-01"), 1, "century")',
  ],
  [
    "dateSubtract",
    'dateSubtract(parseDate("2026-01-02"), 1, "day")',
    { start: "2026-01-01", includeTime: false },
    "dateSubtract()",
    'dateSubtract(parseDate("2026-01-01"), 1.5, "day")',
  ],
  [
    "dateBetween",
    'dateBetween(parseDate("2026-01-03"), parseDate("2026-01-01"), "days")',
    2,
    "dateBetween()",
    'dateBetween(parseDate("2026-01-03"), parseDate("2026-01-01"), "century")',
  ],
];

test("public formula allowlist is the exact essential tier", async () => {
  const { DATABASE_FORMULA_PUBLIC_FUNCTIONS } = await import(
    "./databaseFormulaCompiler.ts"
  );
  assert.deepEqual(
    [...DATABASE_FORMULA_PUBLIC_FUNCTIONS].sort(),
    cases.map(([name]) => name).sort(),
  );
  const unsupported = await run("SIN(1)");
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED_FUNCTION");
});

test("every essential function has production success, arity, and type/null behavior", async (t) => {
  for (const [name, source, expected, wrongArity, wrongType] of cases) {
    await t.test(name, async () => {
      assert.deepEqual(await run(source), {
        ok: true,
        value: expected,
        usesNow: name === "now" || name === "today",
      });
      const arity = await run(wrongArity);
      assert.equal(arity.ok, false, `${name} arity`);
      assert.equal(arity.error.code, "TYPE_MISMATCH", `${name} arity`);
      if (wrongType) {
        const type = await run(wrongType);
        assert.equal(type.ok, false, `${name} type/null`);
        assert.ok(
          ["TYPE_MISMATCH", "DIVIDE_BY_ZERO", "NON_FINITE"].includes(
            type.error.code,
          ),
          `${name} type/null: ${type.error.code}`,
        );
      }
    });
  }
});

test("documented null and empty-list policies remain successful", async () => {
  for (const [source, expected] of [
    ["empty(0)", true],
    ["empty(false)", false],
    ["sum([])", 0],
    ["min([])", null],
    ["max([])", null],
    ["mean([])", null],
    ["concat([])", []],
    ["first([])", null],
    ["last([])", null],
    ["at([], 0)", null],
    ["contains([null], null)", true],
    ["includes([null], null)", true],
    ['format(prop("Empty"))', ""],
  ]) {
    assert.deepEqual(await run(source), {
      ok: true,
      value: expected,
      usesNow: false,
    });
  }
});

test("non-finite and size guards stay on the public evaluator path", async () => {
  for (const [source, code] of [
    ["pow(10, 1000)", "NON_FINITE"],
    ["divide(1, 0)", "DIVIDE_BY_ZERO"],
    ["sqrt(-1)", "NON_FINITE"],
  ]) {
    const result = await run(source);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});
