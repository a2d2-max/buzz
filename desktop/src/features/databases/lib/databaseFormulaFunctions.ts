import {
  AVERAGE,
  LOWER,
  MAX,
  MIN,
  MOD,
  POWER,
  ROUND,
  SUM,
  UPPER,
} from "@formulajs/formulajs";

import type {
  DatabaseComputedScalar,
  DatabaseComputedValue,
  DatabaseFormulaErrorCode,
} from "./databaseComputedValue";
import {
  databaseComparableDate,
  databaseDateValueMatches,
  isDatabaseDateOnly,
  isDatabaseTimedInstant,
} from "./databaseDateValue";
import type { DatabaseDateValue } from "./databaseValue";

const MAX_LIST = 1_000;
const MAX_TEXT_BYTES = 16 * 1_024;
const MAX_TRANSIENT_BYTES = 256 * 1_024;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const DATE_UNITS = new Set([
  "year",
  "years",
  "quarter",
  "quarters",
  "month",
  "months",
  "week",
  "weeks",
  "day",
  "days",
  "hour",
  "hours",
  "minute",
  "minutes",
]);

export class DatabaseFormulaRuntimeError extends Error {
  readonly code: DatabaseFormulaErrorCode;

  constructor(code: DatabaseFormulaErrorCode, message: string) {
    super(message);
    this.name = "DatabaseFormulaRuntimeError";
    this.code = code;
  }
}

export type DatabaseFormulaFunctionContext = {
  nowMs: number;
  propertyValues: readonly unknown[];
  rowId: string;
};

type FormulaFunction = (...args: unknown[]) => unknown;

function fail(code: DatabaseFormulaErrorCode, message: string): never {
  throw new DatabaseFormulaRuntimeError(code, message);
}

function exactArity(name: string, args: unknown[], arity: number): void {
  if (args.length !== arity) {
    fail("TYPE_MISMATCH", `${name} requires ${arity} arguments.`);
  }
}

function arityRange(
  name: string,
  args: unknown[],
  minimum: number,
  maximum: number,
): void {
  if (args.length < minimum || args.length > maximum) {
    fail(
      "TYPE_MISMATCH",
      `${name} requires ${minimum}${minimum === maximum ? "" : `-${maximum}`} arguments.`,
    );
  }
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number") {
    fail("TYPE_MISMATCH", `${name} requires finite numbers.`);
  }
  if (!Number.isFinite(value)) fail("NON_FINITE", `${name} must stay finite.`);
  return value;
}

function integer(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (!Number.isInteger(number)) {
    fail("TYPE_MISMATCH", `${name} requires integer indexes.`);
  }
  return number;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    fail("TYPE_MISMATCH", `${name} requires text.`);
  }
  return value;
}

function list(value: unknown, name: string): DatabaseComputedScalar[] {
  if (!Array.isArray(value)) fail("TYPE_MISMATCH", `${name} requires a list.`);
  if (value.length > MAX_LIST) {
    fail("TOO_COMPLEX", `${name} list exceeds ${MAX_LIST} items.`);
  }
  return value as DatabaseComputedScalar[];
}

function dateValue(value: unknown, name: string): DatabaseDateValue {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("start" in value) ||
    !("includeTime" in value)
  ) {
    fail("TYPE_MISMATCH", `${name} requires a date.`);
  }
  const candidate = value as DatabaseDateValue;
  if (!databaseDateValueMatches(candidate)) {
    fail("TYPE_MISMATCH", `${name} requires a valid date.`);
  }
  return candidate;
}

function cappedText(value: string): string {
  if (new TextEncoder().encode(value).length > MAX_TEXT_BYTES) {
    fail("TOO_COMPLEX", `Text result exceeds ${MAX_TEXT_BYTES} bytes.`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedTextJoin(parts: readonly string[], separator: string): string {
  let bytes = separator.length
    ? utf8Bytes(separator) * Math.max(0, parts.length - 1)
    : 0;
  for (const part of parts) {
    bytes += utf8Bytes(part);
    if (bytes > MAX_TEXT_BYTES) {
      fail("TOO_COMPLEX", `Text result exceeds ${MAX_TEXT_BYTES} bytes.`);
    }
  }
  return parts.join(separator);
}

function checkedResult(value: unknown, name: string): number {
  if (value instanceof Error) {
    fail("FORMULA_EVALUATION", `${name} failed: ${value.message}`);
  }
  return finiteNumber(value, name);
}

function canonicalDate(value: DatabaseDateValue): number | string {
  const comparable = databaseComparableDate(value.start, value.includeTime);
  return comparable ?? fail("TYPE_MISMATCH", "Date is invalid.");
}

function canonicalEndpoint(
  value: string,
  includeTime: boolean,
): number | string {
  const comparable = databaseComparableDate(value, includeTime);
  return comparable ?? fail("TYPE_MISMATCH", "Date endpoint is invalid.");
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) {
    fail("TYPE_MISMATCH", "Comparison requires matching types.");
  }
  if (
    typeof left === "number" ||
    typeof left === "string" ||
    typeof left === "boolean"
  ) {
    if (typeof left === "number") {
      finiteNumber(left, "comparison");
      finiteNumber(right, "comparison");
    }
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      fail("TYPE_MISMATCH", "Comparison requires matching list types.");
    }
    if (left.length !== right.length) return false;
    return left.every((value, index) => canonicalEqual(value, right[index]));
  }
  const leftDate = dateValue(left, "comparison");
  const rightDate = dateValue(right, "comparison");
  if (leftDate.includeTime !== rightDate.includeTime) {
    fail("TYPE_MISMATCH", "Date-only and timed values cannot be compared.");
  }
  if (
    canonicalEndpoint(leftDate.start, leftDate.includeTime) !==
    canonicalEndpoint(rightDate.start, rightDate.includeTime)
  ) {
    return false;
  }
  if ((leftDate.end === undefined) !== (rightDate.end === undefined)) {
    return false;
  }
  return leftDate.end === undefined
    ? true
    : canonicalEndpoint(leftDate.end, leftDate.includeTime) ===
        canonicalEndpoint(rightDate.end as string, rightDate.includeTime);
}

function compareOrdered(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    const leftNumber = finiteNumber(left, "comparison");
    const rightNumber = finiteNumber(right, "comparison");
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const leftDate = dateValue(left, "comparison");
    const rightDate = dateValue(right, "comparison");
    if (leftDate.includeTime !== rightDate.includeTime) {
      fail("TYPE_MISMATCH", "Date-only and timed values cannot be ordered.");
    }
    const leftComparable = canonicalDate(leftDate);
    const rightComparable = canonicalDate(rightDate);
    return leftComparable === rightComparable
      ? 0
      : leftComparable < rightComparable
        ? -1
        : 1;
  }
  fail("TYPE_MISMATCH", "Ordering requires two numbers, texts, or dates.");
}

function numbers(args: unknown[], name: string): number[] {
  const values: number[] = [];
  let visited = 0;
  for (const argument of args) {
    const inputs = Array.isArray(argument) ? list(argument, name) : [argument];
    for (const value of inputs) {
      visited += 1;
      if (visited > MAX_LIST) {
        fail("TOO_COMPLEX", `${name} exceeds ${MAX_LIST} inputs.`);
      }
      if (value !== null) values.push(finiteNumber(value, name));
    }
  }
  return values;
}

function stableFormat(value: unknown): string {
  if (value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number") finiteNumber(value, "format");
    return String(value);
  }
  if (Array.isArray(value)) {
    return boundedTextJoin(value.map(stableFormat), ", ");
  }
  const date = dateValue(value, "format");
  return date.end ? `${date.start} – ${date.end}` : date.start;
}

function endpoint(value: DatabaseDateValue, which: "start" | "end") {
  const selected = which === "end" ? (value.end ?? value.start) : value.start;
  return { start: selected, includeTime: value.includeTime };
}

function epochMilliseconds(value: DatabaseDateValue): number {
  const comparable = canonicalDate(value);
  if (typeof comparable === "number") return comparable;
  return Date.parse(`${comparable}T00:00:00Z`);
}

function offsetSuffix(source: string): string {
  return /(Z|[+-]\d{2}:\d{2})$/u.exec(source)?.[1] ?? "Z";
}

function formatTimedAtOffset(epoch: number, suffix: string): string {
  if (suffix === "Z") return new Date(epoch).toISOString();
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(suffix);
  if (!match) fail("TYPE_MISMATCH", "Timed date offset is invalid.");
  const offset =
    (match[1] === "+" ? 1 : -1) *
    (Number(match[2]) * 60 + Number(match[3])) *
    60_000;
  return `${new Date(epoch + offset).toISOString().slice(0, 23)}${suffix}`;
}

function dateFromEpoch(
  epoch: number,
  includeTime: boolean,
  sourceOffset?: string,
): DatabaseDateValue {
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime()))
    fail("NON_FINITE", "Date is outside range.");
  return {
    start: includeTime
      ? formatTimedAtOffset(
          epoch,
          sourceOffset ? offsetSuffix(sourceOffset) : "Z",
        )
      : date.toISOString().slice(0, 10),
    includeTime,
  };
}

function normalizeDateUnit(value: unknown): string {
  const unit = text(value, "date unit");
  if (!DATE_UNITS.has(unit)) {
    fail("TYPE_MISMATCH", `Unsupported date unit ${unit}.`);
  }
  return unit.endsWith("s") ? unit.slice(0, -1) : unit;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addDateUnits(
  value: unknown,
  amountValue: unknown,
  unitValue: unknown,
): DatabaseDateValue {
  const date = dateValue(value, "dateAdd");
  const amount = integer(amountValue, "dateAdd");
  const unit = normalizeDateUnit(unitValue);
  const outputIncludesTime =
    date.includeTime || unit === "hour" || unit === "minute";
  const addEndpoint = (source: string): string => {
    const epoch = date.includeTime
      ? Date.parse(source)
      : Date.parse(`${source}T00:00:00Z`);
    const current = new Date(epoch);
    if (unit === "month" || unit === "quarter" || unit === "year") {
      const months =
        unit === "year"
          ? amount * 12
          : unit === "quarter"
            ? amount * 3
            : amount;
      const day = current.getUTCDate();
      const monthStart = new Date(
        Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + months, 1),
      );
      monthStart.setUTCDate(
        Math.min(
          day,
          daysInUtcMonth(monthStart.getUTCFullYear(), monthStart.getUTCMonth()),
        ),
      );
      if (outputIncludesTime) {
        monthStart.setUTCHours(
          current.getUTCHours(),
          current.getUTCMinutes(),
          current.getUTCSeconds(),
          current.getUTCMilliseconds(),
        );
      }
      return dateFromEpoch(
        monthStart.getTime(),
        outputIncludesTime,
        date.includeTime ? source : undefined,
      ).start;
    }
    const multiplier =
      unit === "week"
        ? 7 * 86_400_000
        : unit === "day"
          ? 86_400_000
          : unit === "hour"
            ? 3_600_000
            : 60_000;
    return dateFromEpoch(
      epoch + amount * multiplier,
      outputIncludesTime,
      date.includeTime ? source : undefined,
    ).start;
  };
  return {
    start: addEndpoint(date.start),
    ...(date.end ? { end: addEndpoint(date.end) } : {}),
    includeTime: outputIncludesTime,
  };
}

function completedUnits(
  left: DatabaseDateValue,
  right: DatabaseDateValue,
  unit: string,
) {
  if (left.includeTime !== right.includeTime) {
    fail("TYPE_MISMATCH", "dateBetween requires matching date modes.");
  }
  const leftMs = epochMilliseconds(left);
  const rightMs = epochMilliseconds(right);
  const difference = leftMs - rightMs;
  const divisor =
    unit === "minute"
      ? 60_000
      : unit === "hour"
        ? 3_600_000
        : unit === "day"
          ? 86_400_000
          : unit === "week"
            ? 7 * 86_400_000
            : null;
  if (divisor) return Math.trunc(difference / divisor);
  const leftDate = new Date(leftMs);
  const rightDate = new Date(rightMs);
  const months =
    (leftDate.getUTCFullYear() - rightDate.getUTCFullYear()) * 12 +
    leftDate.getUTCMonth() -
    rightDate.getUTCMonth();
  const adjusted = addDateUnits(right, months, "month");
  const completedMonths =
    difference >= 0
      ? epochMilliseconds(adjusted) > leftMs
        ? months - 1
        : months
      : epochMilliseconds(adjusted) < leftMs
        ? months + 1
        : months;
  if (unit === "month") return completedMonths;
  if (unit === "quarter") return Math.trunc(completedMonths / 3);
  return Math.trunc(completedMonths / 12);
}

/** Validates one evaluator output against the bounded computed-value contract. */
export function validateDatabaseComputedValue(
  value: unknown,
): DatabaseComputedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? cappedText(value) : value;
  }
  if (typeof value === "number") return finiteNumber(value, "formula result");
  if (Array.isArray(value)) {
    const values = list(value, "formula result");
    let kind: string | null = null;
    let bytes = 0;
    for (const item of values) {
      if (item === null) continue;
      const itemKind =
        typeof item === "object" && item !== null ? "date" : typeof item;
      if (kind && itemKind !== kind) {
        fail("TYPE_MISMATCH", "Formula lists must be homogeneous.");
      }
      kind = itemKind;
      if (itemKind === "date") dateValue(item, "formula result");
      if (itemKind === "number") finiteNumber(item, "formula result");
      bytes += new TextEncoder().encode(stableFormat(item)).length;
      if (bytes > MAX_TRANSIENT_BYTES) {
        fail("TOO_COMPLEX", "Formula result exceeds the transient size limit.");
      }
    }
    return values;
  }
  return dateValue(value, "formula result");
}

/** Builds the only function registry exposed to expr-eval for one row snapshot. */
export function createDatabaseFormulaFunctions(
  context: DatabaseFormulaFunctionContext,
): Record<string, FormulaFunction> {
  const binaryNumber =
    (
      name: string,
      calculate: (left: number, right: number) => unknown,
    ): FormulaFunction =>
    (...args) => {
      exactArity(name, args, 2);
      return checkedResult(
        calculate(finiteNumber(args[0], name), finiteNumber(args[1], name)),
        name,
      );
    };
  const registry: Record<string, FormulaFunction> = Object.create(null);
  Object.assign(registry, {
    __null: (...args: unknown[]) => {
      exactArity("null", args, 0);
      return null;
    },
    __prop: (...args: unknown[]) => {
      exactArity("prop", args, 1);
      const index = integer(args[0], "prop");
      return context.propertyValues[index] ?? null;
    },
    __bool: (...args: unknown[]) => {
      exactArity("condition", args, 1);
      if (typeof args[0] !== "boolean") {
        fail("TYPE_MISMATCH", "Conditions must be boolean.");
      }
      return args[0];
    },
    __not: (...args: unknown[]) => {
      exactArity("not", args, 1);
      if (typeof args[0] !== "boolean")
        fail("TYPE_MISMATCH", "not requires boolean.");
      return !args[0];
    },
    __eq: (...args: unknown[]) => {
      exactArity("comparison", args, 2);
      return canonicalEqual(args[0], args[1]);
    },
    __ne: (...args: unknown[]) => {
      exactArity("comparison", args, 2);
      return !canonicalEqual(args[0], args[1]);
    },
    __gt: (...args: unknown[]) => compareOrdered(args[0], args[1]) > 0,
    __gte: (...args: unknown[]) => compareOrdered(args[0], args[1]) >= 0,
    __lt: (...args: unknown[]) => compareOrdered(args[0], args[1]) < 0,
    __lte: (...args: unknown[]) => compareOrdered(args[0], args[1]) <= 0,
    __positive: (...args: unknown[]) => {
      exactArity("positive", args, 1);
      return finiteNumber(args[0], "positive");
    },
    __negative: (...args: unknown[]) => {
      exactArity("negative", args, 1);
      return -finiteNumber(args[0], "negative");
    },
    __add: binaryNumber("add", (left, right) => left + right),
    __subtract: binaryNumber("subtract", (left, right) => left - right),
    __multiply: binaryNumber("multiply", (left, right) => left * right),
    __divide: binaryNumber("divide", (left, right) => {
      if (right === 0) fail("DIVIDE_BY_ZERO", "Cannot divide by zero.");
      return left / right;
    }),
    __mod: binaryNumber("mod", (left, right) => {
      if (right === 0) fail("DIVIDE_BY_ZERO", "Cannot divide by zero.");
      return MOD(left, right);
    }),
    __pow: binaryNumber("pow", (left, right) => POWER(left, right)),
  });

  Object.assign(registry, {
    empty: (...args: unknown[]) => {
      exactArity("empty", args, 1);
      const value = args[0];
      return (
        value === null ||
        value === 0 ||
        value === "" ||
        (Array.isArray(value) && !value.length)
      );
    },
    length: (...args: unknown[]) => {
      exactArity("length", args, 1);
      if (typeof args[0] === "string") return args[0].length;
      return list(args[0], "length").length;
    },
    substring: (...args: unknown[]) => {
      arityRange("substring", args, 2, 3);
      const source = text(args[0], "substring");
      const start = integer(args[1], "substring");
      const end = args.length === 3 ? integer(args[2], "substring") : undefined;
      return cappedText(source.slice(start, end));
    },
    contains: (...args: unknown[]) => {
      exactArity("contains", args, 2);
      if (typeof args[0] === "string")
        return args[0].includes(text(args[1], "contains"));
      return list(args[0], "contains").some((item) =>
        canonicalEqual(item, args[1]),
      );
    },
    lower: (...args: unknown[]) => {
      exactArity("lower", args, 1);
      return cappedText(String(LOWER(text(args[0], "lower"))));
    },
    upper: (...args: unknown[]) => {
      exactArity("upper", args, 1);
      return cappedText(String(UPPER(text(args[0], "upper"))));
    },
    trim: (...args: unknown[]) => {
      exactArity("trim", args, 1);
      return text(args[0], "trim").trim();
    },
    format: (...args: unknown[]) => {
      exactArity("format", args, 1);
      return cappedText(stableFormat(args[0]));
    },
    add: registry.__add,
    subtract: registry.__subtract,
    multiply: registry.__multiply,
    divide: registry.__divide,
    mod: registry.__mod,
    pow: registry.__pow,
    min: (...args: unknown[]) => {
      if (!args.length)
        fail("TYPE_MISMATCH", "min requires at least one argument.");
      const values = numbers(args, "min");
      return values.length ? checkedResult(MIN(...values), "min") : null;
    },
    max: (...args: unknown[]) => {
      if (!args.length)
        fail("TYPE_MISMATCH", "max requires at least one argument.");
      const values = numbers(args, "max");
      return values.length ? checkedResult(MAX(...values), "max") : null;
    },
    sum: (...args: unknown[]) => {
      if (!args.length)
        fail("TYPE_MISMATCH", "sum requires at least one argument.");
      return checkedResult(SUM(...numbers(args, "sum")), "sum");
    },
    mean: (...args: unknown[]) => {
      if (!args.length)
        fail("TYPE_MISMATCH", "mean requires at least one argument.");
      const values = numbers(args, "mean");
      return values.length ? checkedResult(AVERAGE(...values), "mean") : null;
    },
    abs: (...args: unknown[]) => {
      exactArity("abs", args, 1);
      return Math.abs(finiteNumber(args[0], "abs"));
    },
    round: (...args: unknown[]) => {
      arityRange("round", args, 1, 2);
      const digits = args.length === 2 ? integer(args[1], "round") : 0;
      if (digits < -15 || digits > 15)
        fail("TYPE_MISMATCH", "round digits must be -15 through 15.");
      return checkedResult(
        ROUND(finiteNumber(args[0], "round"), digits),
        "round",
      );
    },
    ceil: (...args: unknown[]) => {
      exactArity("ceil", args, 1);
      return Math.ceil(finiteNumber(args[0], "ceil"));
    },
    floor: (...args: unknown[]) => {
      exactArity("floor", args, 1);
      return Math.floor(finiteNumber(args[0], "floor"));
    },
    sqrt: (...args: unknown[]) => {
      exactArity("sqrt", args, 1);
      return checkedResult(Math.sqrt(finiteNumber(args[0], "sqrt")), "sqrt");
    },
    pi: (...args: unknown[]) => {
      exactArity("pi", args, 0);
      return Math.PI;
    },
    toNumber: (...args: unknown[]) => {
      exactArity("toNumber", args, 1);
      const value = args[0];
      if (typeof value === "number") return finiteNumber(value, "toNumber");
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value === "string") {
        if (!DECIMAL.test(value))
          fail("TYPE_MISMATCH", "toNumber requires complete decimal text.");
        return finiteNumber(Number(value), "toNumber");
      }
      return epochMilliseconds(dateValue(value, "toNumber"));
    },
  });

  Object.assign(registry, {
    at: (...args: unknown[]) => {
      exactArity("at", args, 2);
      return list(args[0], "at")[integer(args[1], "at")] ?? null;
    },
    first: (...args: unknown[]) => {
      exactArity("first", args, 1);
      return list(args[0], "first")[0] ?? null;
    },
    last: (...args: unknown[]) => {
      exactArity("last", args, 1);
      return list(args[0], "last").at(-1) ?? null;
    },
    slice: (...args: unknown[]) => {
      arityRange("slice", args, 2, 3);
      const values = list(args[0], "slice");
      return values.slice(
        integer(args[1], "slice"),
        args.length === 3 ? integer(args[2], "slice") : undefined,
      );
    },
    concat: (...args: unknown[]) => {
      if (!args.length)
        fail("TYPE_MISMATCH", "concat requires at least one argument.");
      const inputs = args.map((value) => list(value, "concat"));
      const length = inputs.reduce((total, values) => total + values.length, 0);
      if (length > MAX_LIST) {
        fail("TOO_COMPLEX", `concat list exceeds ${MAX_LIST} items.`);
      }
      return inputs.flat();
    },
    join: (...args: unknown[]) => {
      exactArity("join", args, 2);
      const values = list(args[0], "join");
      if (!values.every((value) => typeof value === "string")) {
        fail("TYPE_MISMATCH", "join requires a text list.");
      }
      return boundedTextJoin(values, text(args[1], "join"));
    },
    split: (...args: unknown[]) => {
      exactArity("split", args, 2);
      const source = text(args[0], "split");
      const separator = text(args[1], "split");
      if (!separator) {
        if (source.length > MAX_LIST) {
          fail("TOO_COMPLEX", `split list exceeds ${MAX_LIST} items.`);
        }
        return source.split("");
      }
      const values: string[] = [];
      let offset = 0;
      while (true) {
        const next = source.indexOf(separator, offset);
        if (next < 0) {
          values.push(source.slice(offset));
          break;
        }
        values.push(source.slice(offset, next));
        if (values.length >= MAX_LIST) {
          fail("TOO_COMPLEX", `split list exceeds ${MAX_LIST} items.`);
        }
        offset = next + separator.length;
      }
      return values;
    },
    includes: (...args: unknown[]) => {
      exactArity("includes", args, 2);
      return list(args[0], "includes").some((item) =>
        canonicalEqual(item, args[1]),
      );
    },
    id: (...args: unknown[]) => {
      exactArity("id", args, 0);
      return context.rowId;
    },
    parseDate: (...args: unknown[]) => {
      exactArity("parseDate", args, 1);
      const source = text(args[0], "parseDate");
      if (isDatabaseDateOnly(source))
        return { start: source, includeTime: false };
      if (isDatabaseTimedInstant(source))
        return { start: source, includeTime: true };
      fail(
        "TYPE_MISMATCH",
        "parseDate requires YYYY-MM-DD or an offset timestamp.",
      );
    },
    dateRange: (...args: unknown[]) => {
      exactArity("dateRange", args, 2);
      const start = dateValue(args[0], "dateRange");
      const end = dateValue(args[1], "dateRange");
      if (
        start.includeTime !== end.includeTime ||
        canonicalDate(end) < canonicalDate(start)
      ) {
        fail(
          "TYPE_MISMATCH",
          "dateRange requires matching modes and end after start.",
        );
      }
      return {
        start: start.start,
        end: end.start,
        includeTime: start.includeTime,
      };
    },
    dateStart: (...args: unknown[]) => {
      exactArity("dateStart", args, 1);
      return endpoint(dateValue(args[0], "dateStart"), "start");
    },
    dateEnd: (...args: unknown[]) => {
      exactArity("dateEnd", args, 1);
      return endpoint(dateValue(args[0], "dateEnd"), "end");
    },
    timestamp: (...args: unknown[]) => {
      exactArity("timestamp", args, 1);
      return epochMilliseconds(dateValue(args[0], "timestamp"));
    },
    now: (...args: unknown[]) => {
      exactArity("now", args, 0);
      return dateFromEpoch(context.nowMs, true);
    },
    today: (...args: unknown[]) => {
      exactArity("today", args, 0);
      return dateFromEpoch(context.nowMs, false);
    },
    dateAdd: (...args: unknown[]) => {
      exactArity("dateAdd", args, 3);
      return addDateUnits(args[0], args[1], args[2]);
    },
    dateSubtract: (...args: unknown[]) => {
      exactArity("dateSubtract", args, 3);
      return addDateUnits(args[0], -integer(args[1], "dateSubtract"), args[2]);
    },
    dateBetween: (...args: unknown[]) => {
      exactArity("dateBetween", args, 3);
      return completedUnits(
        dateValue(args[0], "dateBetween"),
        dateValue(args[1], "dateBetween"),
        normalizeDateUnit(args[2]),
      );
    },
  });
  return registry;
}
