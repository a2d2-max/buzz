import { truncatePubkey } from "@/shared/lib/pubkey";

import {
  databaseComputedValueText,
  isDatabaseComputedError,
  type DatabaseComputedError,
  type DatabaseComputedValue,
} from "./databaseComputedValue";
import {
  databaseComputedResultIsList,
  databaseComputedScalarType,
  databaseComputedValueMatchesResultType,
  databasePropertyComputedResultType,
} from "./databaseComputedType";
import type { DatabaseRow } from "./databaseRowCodec";
import type {
  DatabaseFilter,
  DatabaseFilterOperator,
  DatabaseFilterRule,
  DatabaseProperty,
  DatabaseSchema,
  DatabaseView,
} from "./databaseSchemaCodec";
import type { DatabaseCellValue, DatabaseDateValue } from "./databaseValue";
import {
  databaseComparableDate,
  isDatabaseDateOnly,
  isDatabaseTimedInstant,
} from "./databaseDateValue";

export type DatabaseResolvedValue =
  | DatabaseCellValue
  | DatabaseComputedValue
  | DatabaseComputedError
  | undefined;
export type DatabaseValueResolver = (
  row: DatabaseRow,
  property: DatabaseProperty,
) => DatabaseResolvedValue;

export type ResolvedDatabaseRow = {
  row: DatabaseRow;
  values: ReadonlyMap<string, DatabaseResolvedValue>;
};

export type DatabaseRowGroup = {
  key: string;
  label: string;
  value: Exclude<DatabaseResolvedValue, undefined>;
  rows: ResolvedDatabaseRow[];
  empty: boolean;
  recoverable?: boolean;
};

export type DatabaseViewDiagnostic = {
  kind: "missing_property" | "invalid_operator" | "invalid_value";
  propertyId: string;
};

export type DatabaseViewResult = {
  rows: ResolvedDatabaseRow[];
  groups: DatabaseRowGroup[];
  groupProperty: DatabaseProperty | null;
  groupError: "missing" | "unknown" | "incompatible" | null;
  diagnostics: DatabaseViewDiagnostic[];
  computedErrors: Array<{
    rowId: string;
    propertyId: string;
    error: DatabaseComputedError;
  }>;
};

const TEXT_TYPES = new Set([
  "title",
  "text",
  "url",
  "email",
  "phone",
  "created_by",
  "last_edited_by",
]);
const EMPTY_OPERATORS = new Set(["is_empty", "is_not_empty"]);
const TEXT_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
]);
const ORDER_OPERATORS = new Set([
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);
const DATE_OPERATORS = new Set([
  "equals",
  "not_equals",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
]);
const COMPUTED_OPERATORS = new Set([
  ...TEXT_OPERATORS,
  ...ORDER_OPERATORS,
  ...DATE_OPERATORS,
]);

function defaultValue(
  row: DatabaseRow,
  property: DatabaseProperty,
): DatabaseResolvedValue {
  switch (property.type) {
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "created_by":
      return row.createdBy;
    case "last_edited_by":
      return row.author;
    default:
      return row.values[property.id] ?? null;
  }
}

export function databaseValueIsEmpty(value: DatabaseResolvedValue): boolean {
  if (isDatabaseComputedError(value)) return false;
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isDateValue(value: DatabaseResolvedValue): value is DatabaseDateValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "start" in value &&
    typeof value.start === "string" &&
    typeof value.includeTime === "boolean"
  );
}

function lower(value: string): string {
  return value.toLocaleLowerCase();
}

function comparePrimitive(left: number | string, right: number | string) {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function operatorResult(
  operator: DatabaseFilterOperator,
  comparison: number,
): boolean {
  switch (operator) {
    case "equals":
      return comparison === 0;
    case "not_equals":
      return comparison !== 0;
    case "greater_than":
    case "after":
      return comparison > 0;
    case "greater_than_or_equal":
    case "on_or_after":
      return comparison >= 0;
    case "less_than":
    case "before":
      return comparison < 0;
    case "less_than_or_equal":
    case "on_or_before":
      return comparison <= 0;
    default:
      return false;
  }
}

function validOperators(property: DatabaseProperty): ReadonlySet<string> {
  if (TEXT_TYPES.has(property.type)) return TEXT_OPERATORS;
  switch (property.type) {
    case "number":
    case "created_time":
    case "last_edited_time":
      return ORDER_OPERATORS;
    case "select":
    case "status":
    case "multi_select":
    case "person":
    case "relation":
      return TEXT_OPERATORS;
    case "date":
      return DATE_OPERATORS;
    case "checkbox":
      return new Set(["is_checked", "is_not_checked"]);
    case "formula":
    case "rollup": {
      const resultType = databasePropertyComputedResultType(property);
      if (resultType === "unknown") return COMPUTED_OPERATORS;
      if (databaseComputedResultIsList(resultType)) {
        return new Set(["contains", "not_contains"]);
      }
      switch (databaseComputedScalarType(resultType)) {
        case "number":
          return ORDER_OPERATORS;
        case "boolean":
          return new Set(["equals", "not_equals"]);
        case "date":
          return DATE_OPERATORS;
        default:
          return TEXT_OPERATORS;
      }
    }
    default:
      return TEXT_OPERATORS;
  }
}

function computedValueMatchesResultType(
  value: DatabaseResolvedValue,
  property: DatabaseProperty,
): boolean {
  if (property.type !== "formula" && property.type !== "rollup") {
    return true;
  }
  if (value === null || value === undefined || isDatabaseComputedError(value)) {
    return true;
  }
  const resultType = databasePropertyComputedResultType(property);
  if (resultType === "unknown") return true;
  return databaseComputedValueMatchesResultType(value, resultType);
}

function stringArrayEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function evaluateRuleValue(
  property: DatabaseProperty,
  value: DatabaseResolvedValue,
  rule: DatabaseFilterRule,
): { result: boolean; invalid?: true } {
  if (isDatabaseComputedError(value)) return { result: false };
  if (EMPTY_OPERATORS.has(rule.operator)) {
    const empty = databaseValueIsEmpty(value);
    return { result: rule.operator === "is_empty" ? empty : !empty };
  }
  if (!validOperators(property).has(rule.operator)) {
    return { result: false, invalid: true };
  }
  if (databaseValueIsEmpty(value)) return { result: false };
  if (property.type === "checkbox") {
    if (typeof value !== "boolean") return { result: false };
    return {
      result: rule.operator === "is_checked" ? value : !value,
    };
  }
  if (property.type === "formula" || property.type === "rollup") {
    if (!computedValueMatchesResultType(value, property)) {
      return { result: false, invalid: true };
    }
    if (typeof value === "number") {
      if (typeof rule.value !== "number" || !Number.isFinite(rule.value)) {
        return { result: false, invalid: true };
      }
      return {
        result: operatorResult(
          rule.operator,
          comparePrimitive(value, rule.value),
        ),
      };
    }
    if (typeof value === "boolean") {
      if (typeof rule.value !== "boolean") {
        return { result: false, invalid: true };
      }
      const equal = value === rule.value;
      return { result: rule.operator === "equals" ? equal : !equal };
    }
    if (isDateValue(value)) {
      const synthetic = { ...property, type: "date" } as DatabaseProperty;
      return evaluateRuleValue(synthetic, value, rule);
    }
    if (Array.isArray(value)) {
      if (rule.operator === "contains" || rule.operator === "not_contains") {
        const expected = JSON.stringify(rule.value);
        const contains = value.some(
          (entry) => JSON.stringify(entry) === expected,
        );
        return {
          result: rule.operator === "contains" ? contains : !contains,
        };
      }
      if (!Array.isArray(rule.value)) return { result: false, invalid: true };
      const equal = JSON.stringify(value) === JSON.stringify(rule.value);
      return { result: rule.operator === "equals" ? equal : !equal };
    }
    if (typeof value !== "string" || typeof rule.value !== "string") {
      return { result: false, invalid: true };
    }
    const contains = lower(value).includes(lower(rule.value));
    if (rule.operator === "contains" || rule.operator === "not_contains") {
      return { result: rule.operator === "contains" ? contains : !contains };
    }
    const comparison = comparePrimitive(value, rule.value);
    return { result: operatorResult(rule.operator, comparison) };
  }
  if (property.type === "date") {
    if (!isDateValue(value)) return { result: false };
    const current = databaseComparableDate(value.start, value.includeTime);
    if (current === null) return { result: false };
    if (rule.operator === "between") {
      if (
        !Array.isArray(rule.value) ||
        rule.value.length !== 2 ||
        typeof rule.value[0] !== "string" ||
        typeof rule.value[1] !== "string"
      ) {
        return { result: false, invalid: true };
      }
      const start = databaseComparableDate(rule.value[0], value.includeTime);
      const end = databaseComparableDate(rule.value[1], value.includeTime);
      if (start === null || end === null)
        return { result: false, invalid: true };
      return {
        result:
          comparePrimitive(current, start) >= 0 &&
          comparePrimitive(current, end) <= 0,
      };
    }
    if (typeof rule.value !== "string") return { result: false, invalid: true };
    const bound = databaseComparableDate(rule.value, value.includeTime);
    if (bound === null) return { result: false, invalid: true };
    return {
      result: operatorResult(rule.operator, comparePrimitive(current, bound)),
    };
  }
  if (
    property.type === "number" ||
    property.type === "created_time" ||
    property.type === "last_edited_time"
  ) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      typeof rule.value !== "number" ||
      !Number.isFinite(rule.value)
    ) {
      return { result: false, invalid: true };
    }
    return {
      result: operatorResult(
        rule.operator,
        comparePrimitive(value, rule.value),
      ),
    };
  }
  if (
    property.type === "multi_select" ||
    property.type === "person" ||
    property.type === "relation"
  ) {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === "string")
    ) {
      return { result: false };
    }
    if (rule.operator === "contains" || rule.operator === "not_contains") {
      if (typeof rule.value !== "string")
        return { result: false, invalid: true };
      const contains = value.includes(rule.value);
      return { result: rule.operator === "contains" ? contains : !contains };
    }
    if (
      !Array.isArray(rule.value) ||
      !rule.value.every((entry) => typeof entry === "string")
    ) {
      return { result: false, invalid: true };
    }
    const equal = stringArrayEqual(value, rule.value);
    return { result: rule.operator === "equals" ? equal : !equal };
  }
  if (typeof value !== "string" || typeof rule.value !== "string") {
    return { result: false, invalid: true };
  }
  const exactIds = property.type === "select" || property.type === "status";
  const left = exactIds ? value : lower(value);
  const right = exactIds ? rule.value : lower(rule.value);
  if (rule.operator === "contains" || rule.operator === "not_contains") {
    const contains = exactIds ? left === right : left.includes(right);
    return { result: rule.operator === "contains" ? contains : !contains };
  }
  const equal = left === right;
  return { result: rule.operator === "equals" ? equal : !equal };
}

function filterValueIsValid(
  property: DatabaseProperty,
  rule: DatabaseFilterRule,
): boolean {
  if (EMPTY_OPERATORS.has(rule.operator)) return rule.value === undefined;
  if (property.type === "checkbox") {
    return (
      (rule.operator === "is_checked" || rule.operator === "is_not_checked") &&
      rule.value === undefined
    );
  }
  if (
    property.type === "number" ||
    property.type === "created_time" ||
    property.type === "last_edited_time"
  ) {
    return typeof rule.value === "number" && Number.isFinite(rule.value);
  }
  if (property.type === "date") {
    if (rule.operator === "between") {
      if (!Array.isArray(rule.value) || rule.value.length !== 2) return false;
      const [start, end] = rule.value;
      if (typeof start !== "string" || typeof end !== "string") return false;
      return (
        (isDatabaseDateOnly(start) && isDatabaseDateOnly(end)) ||
        (isDatabaseTimedInstant(start) && isDatabaseTimedInstant(end))
      );
    }
    return (
      typeof rule.value === "string" &&
      (isDatabaseDateOnly(rule.value) || isDatabaseTimedInstant(rule.value))
    );
  }
  if (property.type === "formula" || property.type === "rollup") {
    const resultType = databasePropertyComputedResultType(property);
    if (resultType !== "unknown") {
      if (databaseComputedResultIsList(resultType)) {
        return (
          (rule.operator === "contains" || rule.operator === "not_contains") &&
          (databaseComputedScalarType(resultType) === "number"
            ? typeof rule.value === "number" && Number.isFinite(rule.value)
            : databaseComputedScalarType(resultType) === "boolean"
              ? typeof rule.value === "boolean"
              : databaseComputedScalarType(resultType) === "date"
                ? typeof rule.value === "object" &&
                  rule.value !== null &&
                  !Array.isArray(rule.value) &&
                  isDateValue(rule.value)
                : typeof rule.value === "string")
        );
      }
      if (databaseComputedScalarType(resultType) === "number") {
        return typeof rule.value === "number" && Number.isFinite(rule.value);
      }
      if (databaseComputedScalarType(resultType) === "boolean") {
        return typeof rule.value === "boolean";
      }
      if (databaseComputedScalarType(resultType) === "date") {
        if (rule.operator === "between") {
          return (
            Array.isArray(rule.value) &&
            rule.value.length === 2 &&
            rule.value.every(
              (value) =>
                typeof value === "string" &&
                (isDatabaseDateOnly(value) || isDatabaseTimedInstant(value)),
            )
          );
        }
        return (
          typeof rule.value === "string" &&
          (isDatabaseDateOnly(rule.value) || isDatabaseTimedInstant(rule.value))
        );
      }
      return typeof rule.value === "string";
    }
    if (rule.operator === "between") {
      return (
        Array.isArray(rule.value) &&
        rule.value.length === 2 &&
        rule.value.every(
          (value) =>
            typeof value === "number" ||
            (typeof value === "string" &&
              (isDatabaseDateOnly(value) || isDatabaseTimedInstant(value))),
        )
      );
    }
    return (
      rule.value !== undefined &&
      (typeof rule.value !== "number" || Number.isFinite(rule.value))
    );
  }
  if (
    property.type === "multi_select" ||
    property.type === "person" ||
    property.type === "relation"
  ) {
    if (rule.operator === "contains" || rule.operator === "not_contains") {
      return typeof rule.value === "string";
    }
    return (
      Array.isArray(rule.value) &&
      rule.value.every((value) => typeof value === "string")
    );
  }
  return typeof rule.value === "string";
}

function validateResolvedFilter(
  filter: DatabaseFilter,
  rows: readonly ResolvedDatabaseRow[],
  properties: ReadonlyMap<string, DatabaseProperty>,
  addDiagnostic: (diagnostic: DatabaseViewDiagnostic) => void,
): void {
  if (filter.kind === "group") {
    for (const child of filter.filters) {
      validateResolvedFilter(child, rows, properties, addDiagnostic);
    }
    return;
  }
  const property = properties.get(filter.propertyId);
  if (
    !property ||
    (!EMPTY_OPERATORS.has(filter.operator) &&
      !validOperators(property).has(filter.operator))
  )
    return;
  for (const row of rows) {
    const value = row.values.get(property.id);
    if (isDatabaseComputedError(value) && value.code === "TYPE_MISMATCH") {
      addDiagnostic({ kind: "invalid_value", propertyId: property.id });
      return;
    }
    if (!computedValueMatchesResultType(value, property)) {
      addDiagnostic({ kind: "invalid_value", propertyId: property.id });
      return;
    }
    if (evaluateRuleValue(property, value, filter).invalid) {
      addDiagnostic({ kind: "invalid_value", propertyId: property.id });
      return;
    }
  }
}

function validateFilter(
  filter: DatabaseFilter,
  properties: ReadonlyMap<string, DatabaseProperty>,
  addDiagnostic: (diagnostic: DatabaseViewDiagnostic) => void,
): void {
  if (filter.kind === "group") {
    for (const child of filter.filters)
      validateFilter(child, properties, addDiagnostic);
    return;
  }
  const property = properties.get(filter.propertyId);
  if (!property) {
    addDiagnostic({ kind: "missing_property", propertyId: filter.propertyId });
    return;
  }
  if (
    !EMPTY_OPERATORS.has(filter.operator) &&
    !validOperators(property).has(filter.operator)
  ) {
    addDiagnostic({ kind: "invalid_operator", propertyId: property.id });
    return;
  }
  if (!filterValueIsValid(property, filter)) {
    addDiagnostic({ kind: "invalid_value", propertyId: property.id });
  }
}

function evaluateFilter(
  filter: DatabaseFilter,
  row: ResolvedDatabaseRow,
  properties: ReadonlyMap<string, DatabaseProperty>,
): boolean {
  if (filter.kind === "group") {
    return filter.operator === "and"
      ? filter.filters.every((child) => evaluateFilter(child, row, properties))
      : filter.filters.some((child) => evaluateFilter(child, row, properties));
  }
  const property = properties.get(filter.propertyId);
  if (!property) return false;
  if (
    (!EMPTY_OPERATORS.has(filter.operator) &&
      !validOperators(property).has(filter.operator)) ||
    !filterValueIsValid(property, filter)
  ) {
    return false;
  }
  return evaluateRuleValue(property, row.values.get(property.id), filter)
    .result;
}

function sortableValue(
  property: DatabaseProperty,
  value: DatabaseResolvedValue,
): number | string {
  if (isDatabaseComputedError(value)) return value.code;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (property.type === "select" || property.type === "status") {
      const index = property.options.choices.findIndex(
        (choice) => choice.id === value,
      );
      return index < 0 ? `unknown:${value}` : index;
    }
    return lower(value);
  }
  if (Array.isArray(value)) {
    return value.map(databaseComputedValueText).join("\u0000");
  }
  if (isDateValue(value)) {
    return (
      databaseComparableDate(value.start, value.includeTime) ?? value.start
    );
  }
  return String(value);
}

function compareRows(
  left: ResolvedDatabaseRow,
  right: ResolvedDatabaseRow,
  view: DatabaseView,
  properties: ReadonlyMap<string, DatabaseProperty>,
): number {
  for (const sort of view.sorts) {
    const property = properties.get(sort.propertyId);
    if (!property) continue;
    const leftValue = left.values.get(property.id);
    const rightValue = right.values.get(property.id);
    const leftEmpty =
      databaseValueIsEmpty(leftValue) ||
      (typeof leftValue === "number" && !Number.isFinite(leftValue));
    const rightEmpty =
      databaseValueIsEmpty(rightValue) ||
      (typeof rightValue === "number" && !Number.isFinite(rightValue));
    const leftError = isDatabaseComputedError(leftValue);
    const rightError = isDatabaseComputedError(rightValue);
    if (leftError !== rightError) return leftError ? 1 : -1;
    if (leftError && rightError) continue;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty) continue;
    const compared = comparePrimitive(
      sortableValue(property, leftValue),
      sortableValue(property, rightValue),
    );
    if (compared !== 0) {
      return sort.direction === "ascending" ? compared : -compared;
    }
  }
  return left.row.id.localeCompare(right.row.id);
}

type GroupSeed = Omit<DatabaseRowGroup, "rows"> & {
  order: number | string;
  rows: ResolvedDatabaseRow[];
};

function emptyGroup(): GroupSeed {
  return {
    key: "empty",
    label: "Empty",
    value: null,
    rows: [],
    empty: true,
    order: Number.MAX_SAFE_INTEGER,
  };
}

function choiceOrder(property: DatabaseProperty, index: number): number {
  if (property.type !== "status") return index;
  const choice = property.options.choices[index];
  const semantic =
    choice?.group === "todo" ? 0 : choice?.group === "doing" ? 1 : 2;
  return semantic * 10_000 + index;
}

function scalarGroupSeed(
  property: DatabaseProperty,
  value: Exclude<DatabaseResolvedValue, undefined | null>,
): GroupSeed {
  if (isDatabaseComputedError(value)) {
    return {
      key: `error:${value.code}:${value.detail}`,
      label: `${value.code}: ${value.detail}`,
      value,
      rows: [],
      empty: false,
      recoverable: true,
      order: `error:${value.code}`,
    };
  }
  if (
    (property.type === "select" || property.type === "status") &&
    typeof value === "string"
  ) {
    const index = property.options.choices.findIndex(
      (choice) => choice.id === value,
    );
    const choice = property.options.choices[index];
    return choice
      ? {
          key: `choice:${choice.id}`,
          label: choice.name,
          value,
          rows: [],
          empty: false,
          order: choiceOrder(property, index),
        }
      : {
          key: `unknown:${value}`,
          label: `Unknown option (${value})`,
          value,
          rows: [],
          empty: false,
          recoverable: true,
          order: `unknown:${value}`,
        };
  }
  if (typeof value === "string") {
    return {
      key: `string:${value}`,
      label: property.type === "person" ? truncatePubkey(value) : value,
      value,
      rows: [],
      empty: false,
      order: lower(value),
    };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return {
      key: `${typeof value}:${value}`,
      label: String(value),
      value,
      rows: [],
      empty: false,
      order: sortableValue(property, value),
    };
  }
  const key = JSON.stringify(value);
  return {
    key: `value:${key}`,
    label: Array.isArray(value)
      ? value.map(databaseComputedValueText).join(", ")
      : value.end
        ? `${value.start} – ${value.end}`
        : value.start,
    value,
    rows: [],
    empty: false,
    order: key,
  };
}

function groupRows(
  rows: ResolvedDatabaseRow[],
  property: DatabaseProperty,
  direction: "ascending" | "descending",
): DatabaseRowGroup[] {
  const groups = new Map<string, GroupSeed>();
  if (property.type === "select" || property.type === "status") {
    property.options.choices.forEach((choice, index) => {
      groups.set(`choice:${choice.id}`, {
        key: `choice:${choice.id}`,
        label: choice.name,
        value: choice.id,
        rows: [],
        empty: false,
        order: choiceOrder(property, index),
      });
    });
  }
  const empty = emptyGroup();
  for (const row of rows) {
    const value = row.values.get(property.id);
    if (databaseValueIsEmpty(value)) {
      empty.rows.push(row);
      continue;
    }
    const values: Array<Exclude<DatabaseResolvedValue, undefined | null>> =
      property.type === "person" && Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [value as Exclude<DatabaseResolvedValue, undefined | null>];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      const seed = scalarGroupSeed(property, item);
      const existing = groups.get(seed.key) ?? seed;
      existing.rows.push(row);
      groups.set(seed.key, existing);
    }
  }
  const ordered = [...groups.values()].sort((left, right) => {
    if (Boolean(left.recoverable) !== Boolean(right.recoverable)) {
      return left.recoverable ? 1 : -1;
    }
    const compared = comparePrimitive(left.order, right.order);
    return direction === "ascending" ? compared : -compared;
  });
  return [...ordered, empty].map(({ order: _order, ...group }) => group);
}

/** Resolves, filters, sorts, and groups database rows for every saved view. */
export function resolveDatabaseView({
  schema,
  view,
  rows,
  resolveValue = defaultValue,
}: {
  schema: DatabaseSchema;
  view: DatabaseView;
  rows: DatabaseRow[];
  resolveValue?: DatabaseValueResolver;
}): DatabaseViewResult {
  const properties = new Map(
    schema.properties.map((property) => [property.id, property]),
  );
  const resolved = rows.map((row) => ({
    row,
    values: new Map(
      schema.properties.map((property) => [
        property.id,
        resolveValue(row, property),
      ]),
    ),
  }));
  const computedErrors = resolved.flatMap(({ row, values }) =>
    [...values.entries()]
      .filter((entry): entry is [string, DatabaseComputedError] =>
        isDatabaseComputedError(entry[1]),
      )
      .map(([propertyId, error]) => ({
        rowId: row.id,
        propertyId,
        error,
      })),
  );
  const diagnostics: DatabaseViewDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const addDiagnostic = (diagnostic: DatabaseViewDiagnostic) => {
    const key = `${diagnostic.kind}:${diagnostic.propertyId}`;
    if (!diagnosticKeys.has(key)) {
      diagnosticKeys.add(key);
      diagnostics.push(diagnostic);
    }
  };
  if (view.filter) validateFilter(view.filter, properties, addDiagnostic);
  if (view.filter) {
    validateResolvedFilter(view.filter, resolved, properties, addDiagnostic);
  }
  const filtered = view.filter
    ? resolved.filter((row) =>
        evaluateFilter(view.filter as DatabaseFilter, row, properties),
      )
    : resolved;
  const sorted = [...filtered].sort((left, right) =>
    compareRows(left, right, view, properties),
  );
  if (!view.group) {
    return {
      rows: sorted,
      groups: [],
      groupProperty: null,
      groupError: "missing",
      diagnostics,
      computedErrors,
    };
  }
  const groupProperty = properties.get(view.group.propertyId) ?? null;
  if (!groupProperty) {
    return {
      rows: sorted,
      groups: [],
      groupProperty: null,
      groupError: "unknown",
      diagnostics,
      computedErrors,
    };
  }
  const incompatible =
    (view.type === "board" &&
      !["select", "status", "person"].includes(groupProperty.type)) ||
    (view.type === "calendar" && groupProperty.type !== "date");
  if (incompatible) {
    return {
      rows: sorted,
      groups: [],
      groupProperty,
      groupError: "incompatible",
      diagnostics,
      computedErrors,
    };
  }
  return {
    rows: sorted,
    groups: groupRows(sorted, groupProperty, view.group.direction),
    groupProperty,
    groupError: null,
    diagnostics,
    computedErrors,
  };
}
