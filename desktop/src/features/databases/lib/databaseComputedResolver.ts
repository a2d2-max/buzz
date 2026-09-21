import {
  databaseComputedError,
  isDatabaseComputedError,
  type DatabaseComputedError,
  type DatabaseComputedValue,
} from "./databaseComputedValue";
import {
  compileDatabaseFormula,
  type DatabaseFormulaCompilation,
} from "./databaseFormulaCompiler";
import { evaluateDatabaseFormulaCompilation } from "./databaseFormulaEvaluator";
import {
  DatabaseFormulaRuntimeError,
  validateDatabaseComputedValue,
} from "./databaseFormulaFunctions";
import {
  databaseComputedValueMatchesResultType,
  databasePropertyComputedResultType,
} from "./databaseComputedType";
import type { DatabaseRow } from "./databaseRowCodec";
import type { DatabaseProperty, DatabaseSchema } from "./databaseSchemaCodec";
import type { DatabaseCellValue } from "./databaseValue";
import { isDatabaseEntityId } from "./databaseValue";

const MAX_LINKS = 1_000;
const MAX_COMPUTED_NODES = 256;
const MAX_COMPUTED_DEPTH = 32;

export type DatabaseComputedResolverValue =
  | DatabaseCellValue
  | DatabaseComputedValue
  | DatabaseComputedError
  | undefined;

export type DatabaseRelationPairState =
  | { ok: true; counterpart: Extract<DatabaseProperty, { type: "relation" }> }
  | { ok: false; error: DatabaseComputedError };

export type DatabaseRelationReverseIndex = {
  links: ReadonlyMap<string, readonly string[]>;
  pairErrors: ReadonlyMap<string, DatabaseComputedError>;
  targetErrors: ReadonlyMap<string, DatabaseComputedError>;
};

function relationPairKey(sourceDatabaseId: string, sourcePropertyId: string) {
  return `${sourceDatabaseId}\u0000${sourcePropertyId}`;
}

function reverseKey(
  sourceDatabaseId: string,
  sourcePropertyId: string,
  targetRowId: string,
): string {
  return `${sourceDatabaseId}\u0000${sourcePropertyId}\u0000${targetRowId}`;
}

function normalizedRelationIds(
  value: unknown,
): string[] | DatabaseComputedError {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    return databaseComputedError(
      "TYPE_MISMATCH",
      "Relation value must be a row-id list.",
    );
  }
  if (value.length > MAX_LINKS) {
    return databaseComputedError(
      "TOO_COMPLEX",
      `Relation has more than ${MAX_LINKS} links.`,
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!isDatabaseEntityId(id)) {
      return databaseComputedError(
        "BROKEN_RELATION",
        `Invalid related row id ${id}.`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Builds the derived inverse relation index from accepted authoritative rows. */
export function buildDatabaseRelationReverseIndex({
  rows,
  schemas,
}: {
  rows: Iterable<DatabaseRow>;
  schemas: ReadonlyMap<string, DatabaseSchema>;
}): DatabaseRelationReverseIndex {
  const mutable = new Map<string, Set<string>>();
  const pairErrors = new Map<string, DatabaseComputedError>();
  const targetErrors = new Map<string, DatabaseComputedError>();
  for (const row of rows) {
    if (row.deleted) continue;
    const schema = schemas.get(row.databaseId);
    if (!schema || schema.deleted) continue;
    for (const property of schema.properties) {
      if (
        property.type !== "relation" ||
        property.options.direction !== "authoritative"
      ) {
        continue;
      }
      const ids = normalizedRelationIds(row.values[property.id] ?? []);
      const pairKey = relationPairKey(schema.id, property.id);
      if (isDatabaseComputedError(ids)) {
        pairErrors.set(pairKey, ids);
        continue;
      }
      for (const targetRowId of ids) {
        const key = reverseKey(schema.id, property.id, targetRowId);
        if (targetErrors.has(key)) continue;
        const sourceRows = mutable.get(key) ?? new Set<string>();
        if (!sourceRows.has(row.id) && sourceRows.size >= MAX_LINKS) {
          mutable.delete(key);
          targetErrors.set(
            key,
            databaseComputedError(
              "TOO_COMPLEX",
              `Reverse relation has more than ${MAX_LINKS} source rows.`,
            ),
          );
          continue;
        }
        sourceRows.add(row.id);
        mutable.set(key, sourceRows);
      }
    }
  }
  return {
    links: new Map(
      [...mutable.entries()].map(([key, sourceRows]) => [key, [...sourceRows]]),
    ),
    pairErrors,
    targetErrors,
  };
}

/** Validates a relation's optional reciprocal property across accepted schemas. */
export function validateDatabaseRelationPair(
  schema: DatabaseSchema,
  property: Extract<DatabaseProperty, { type: "relation" }>,
  schemas: ReadonlyMap<string, DatabaseSchema>,
): DatabaseRelationPairState {
  const counterpartId = property.options.mirroredPropertyId;
  if (!counterpartId) {
    return {
      ok: false,
      error: databaseComputedError(
        "BROKEN_RELATION",
        "This relation is one-way until its reciprocal property is configured.",
      ),
    };
  }
  const targetSchema = schemas.get(property.options.databaseId);
  const counterpart = targetSchema?.properties.find(
    (candidate): candidate is Extract<DatabaseProperty, { type: "relation" }> =>
      candidate.id === counterpartId && candidate.type === "relation",
  );
  if (
    !targetSchema ||
    targetSchema.deleted ||
    !counterpart ||
    counterpart.options.databaseId !== schema.id ||
    counterpart.options.mirroredPropertyId !== property.id ||
    counterpart.options.direction === property.options.direction
  ) {
    return {
      ok: false,
      error: databaseComputedError(
        "BROKEN_RELATION",
        "The reciprocal relation property is missing or does not point back.",
      ),
    };
  }
  return { ok: true, counterpart };
}

type EvaluationState = {
  budget: { nodes: number };
  depth: number;
  stack: Set<string>;
};

function rawValue(row: DatabaseRow, property: DatabaseProperty): unknown {
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

function compileFormula(
  property: Extract<DatabaseProperty, { type: "formula" }>,
  schema: DatabaseSchema,
): DatabaseFormulaCompilation | DatabaseComputedError {
  const compiled = compileDatabaseFormula(
    property.options.expression,
    schema.properties,
  );
  return compiled.ok ? compiled.compilation : compiled.error;
}

function computedKey(
  schema: DatabaseSchema,
  property: DatabaseProperty,
): string {
  return `${schema.id}\u0000${property.id}`;
}

function validateDeclaredResult(
  property: Extract<DatabaseProperty, { type: "formula" | "rollup" }>,
  value: DatabaseComputedValue,
): DatabaseComputedValue | DatabaseComputedError {
  return databaseComputedValueMatchesResultType(
    value,
    databasePropertyComputedResultType(property),
  )
    ? value
    : databaseComputedError(
        "TYPE_MISMATCH",
        `${property.name} did not produce its declared result type.`,
      );
}

/** Creates a community-snapshot-scoped resolver; no computed state escapes it. */
export function createDatabaseComputedResolver({
  nowMs = Date.now(),
  rowHistoryComplete,
  rows,
  schemas,
}: {
  nowMs?: number;
  rowHistoryComplete: boolean;
  rows: ReadonlyMap<string, DatabaseRow>;
  schemas: ReadonlyMap<string, DatabaseSchema>;
}) {
  const reverseIndex = buildDatabaseRelationReverseIndex({
    rows: rows.values(),
    schemas,
  });

  const resolveRelation = (
    row: DatabaseRow,
    schema: DatabaseSchema,
    property: Extract<DatabaseProperty, { type: "relation" }>,
  ): string[] | DatabaseComputedError => {
    if (property.options.direction === "authoritative") {
      return normalizedRelationIds(row.values[property.id] ?? []);
    }
    const pair = validateDatabaseRelationPair(schema, property, schemas);
    if (!pair.ok) return pair.error;
    if (!rowHistoryComplete) {
      return databaseComputedError(
        "SOURCE_INCOMPLETE",
        "Reverse relation history is incomplete; partial links are hidden.",
      );
    }
    const pairError = reverseIndex.pairErrors.get(
      relationPairKey(property.options.databaseId, pair.counterpart.id),
    );
    if (pairError) return pairError;
    const key = reverseKey(
      property.options.databaseId,
      pair.counterpart.id,
      row.id,
    );
    const targetError = reverseIndex.targetErrors.get(key);
    if (targetError) return targetError;
    return [...(reverseIndex.links.get(key) ?? [])];
  };

  const evaluateProperty = (
    row: DatabaseRow,
    schema: DatabaseSchema,
    property: DatabaseProperty,
    state: EvaluationState,
  ): DatabaseComputedResolverValue => {
    if (property.type === "relation") {
      return resolveRelation(row, schema, property);
    }
    if (property.type !== "formula" && property.type !== "rollup") {
      return rawValue(row, property) as DatabaseCellValue;
    }
    const key = computedKey(schema, property);
    if (state.stack.has(key)) {
      return databaseComputedError(
        "CYCLE",
        `Computed dependency cycle at ${property.name}.`,
      );
    }
    state.budget.nodes += 1;
    if (
      state.depth >= MAX_COMPUTED_DEPTH ||
      state.budget.nodes > MAX_COMPUTED_NODES
    ) {
      return databaseComputedError(
        "TOO_COMPLEX",
        "Computed dependency graph exceeds its work bound.",
      );
    }
    const next: EvaluationState = {
      budget: state.budget,
      depth: state.depth + 1,
      stack: new Set(state.stack).add(key),
    };
    if (property.type === "formula") {
      const compilation = compileFormula(property, schema);
      if (isDatabaseComputedError(compilation)) return compilation;
      const values: unknown[] = [];
      for (const propertyId of compilation.propertyIds) {
        const dependency = schema.properties.find(
          (candidate) => candidate.id === propertyId,
        );
        if (!dependency) {
          return databaseComputedError(
            "UNKNOWN_PROPERTY",
            `Property ${propertyId} no longer exists.`,
          );
        }
        const value = evaluateProperty(row, schema, dependency, next);
        if (isDatabaseComputedError(value)) return value;
        values.push(value ?? null);
      }
      const evaluated = evaluateDatabaseFormulaCompilation({
        compilation,
        nowMs,
        propertyValues: values,
        rowId: row.id,
      });
      return evaluated.ok
        ? validateDeclaredResult(property, evaluated.value)
        : evaluated.error;
    }
    const relation = schema.properties.find(
      (
        candidate,
      ): candidate is Extract<DatabaseProperty, { type: "relation" }> =>
        candidate.id === property.options.relationPropertyId &&
        candidate.type === "relation",
    );
    if (!relation) {
      return databaseComputedError(
        "BROKEN_RELATION",
        `Rollup relation ${property.options.relationPropertyId} is missing.`,
      );
    }
    const relatedIds = resolveRelation(row, schema, relation);
    if (isDatabaseComputedError(relatedIds)) return relatedIds;
    const targetSchema = schemas.get(relation.options.databaseId);
    const targetProperty = targetSchema?.properties.find(
      (candidate) => candidate.id === property.options.targetPropertyId,
    );
    if (!targetSchema || targetSchema.deleted || !targetProperty) {
      return databaseComputedError(
        "BROKEN_RELATION",
        "The rollup target database or property is missing.",
      );
    }
    if (targetProperty.type === "rollup") {
      return databaseComputedError(
        "TYPE_MISMATCH",
        "A rollup cannot target another rollup.",
      );
    }
    const values: DatabaseComputedValue[] = [];
    for (const targetId of relatedIds) {
      const targetRow = rows.get(targetId);
      if (
        !targetRow ||
        targetRow.deleted ||
        targetRow.databaseId !== targetSchema.id
      ) {
        return databaseComputedError(
          "BROKEN_RELATION",
          `Related row ${targetId} is missing or belongs to another database.`,
        );
      }
      const value = evaluateProperty(
        targetRow,
        targetSchema,
        targetProperty,
        next,
      );
      if (isDatabaseComputedError(value)) return value;
      values.push((value ?? null) as DatabaseComputedValue);
    }
    const result = calculateDatabaseRollup(
      property.options.calculation,
      values,
    );
    return isDatabaseComputedError(result)
      ? result
      : validateDeclaredResult(property, result);
  };

  return {
    reverseIndex,
    resolveValue: (row: DatabaseRow, property: DatabaseProperty) => {
      const schema = schemas.get(row.databaseId);
      if (!schema || schema.deleted) {
        return databaseComputedError(
          "BROKEN_RELATION",
          "The row database is unavailable.",
        );
      }
      return evaluateProperty(row, schema, property, {
        budget: { nodes: 0 },
        depth: 0,
        stack: new Set(),
      });
    },
  };
}

/** Calculates one complete rollup, never a partial result. */
export function calculateDatabaseRollup(
  calculation: Extract<
    DatabaseProperty,
    { type: "rollup" }
  >["options"]["calculation"],
  values: readonly DatabaseComputedValue[],
): DatabaseComputedValue | DatabaseComputedError {
  if (values.length > MAX_LINKS) {
    return databaseComputedError("TOO_COMPLEX", "Rollup exceeds 1,000 inputs.");
  }
  if (calculation === "count") return values.length;
  if (calculation === "show") {
    try {
      return validateDatabaseComputedValue(values);
    } catch (error) {
      return error instanceof DatabaseFormulaRuntimeError
        ? databaseComputedError(error.code, error.message)
        : databaseComputedError(
            "FORMULA_EVALUATION",
            error instanceof Error
              ? error.message
              : "Rollup validation failed.",
          );
    }
  }
  const numbers = values.filter((value) => value !== null);
  if (
    !numbers.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  ) {
    return databaseComputedError(
      "TYPE_MISMATCH",
      "Numeric rollups require finite numbers or null.",
    );
  }
  const numeric = numbers as number[];
  if (calculation === "sum") {
    const result = numeric.reduce((total, value) => total + value, 0);
    return Number.isFinite(result)
      ? result
      : databaseComputedError("NON_FINITE", "Rollup sum is non-finite.");
  }
  if (!numeric.length) return null;
  if (calculation === "avg") {
    const result =
      numeric.reduce((total, value) => total + value, 0) / numeric.length;
    return Number.isFinite(result)
      ? result
      : databaseComputedError("NON_FINITE", "Rollup average is non-finite.");
  }
  return calculation === "min" ? Math.min(...numeric) : Math.max(...numeric);
}
