import { Parser } from "expr-eval";

import {
  databaseComputedError,
  type DatabaseComputedError,
  type DatabaseComputedValue,
} from "./databaseComputedValue";
import {
  compileDatabaseFormula,
  DATABASE_FORMULA_PARSER_OPTIONS,
  type DatabaseFormulaCompilation,
} from "./databaseFormulaCompiler";
import {
  createDatabaseFormulaFunctions,
  DatabaseFormulaRuntimeError,
  validateDatabaseComputedValue,
} from "./databaseFormulaFunctions";
import type { DatabaseProperty } from "./databaseSchemaCodec";

export type DatabaseFormulaEvaluation =
  | { ok: true; value: DatabaseComputedValue; usesNow: boolean }
  | { ok: false; error: DatabaseComputedError; usesNow: boolean };

/** Evaluates one already-compiled formula against accepted row values. */
export function evaluateDatabaseFormulaCompilation({
  compilation,
  nowMs,
  propertyValues,
  rowId,
}: {
  compilation: DatabaseFormulaCompilation;
  nowMs: number;
  propertyValues: readonly unknown[];
  rowId: string;
}): DatabaseFormulaEvaluation {
  try {
    if (!Number.isFinite(nowMs)) {
      throw new DatabaseFormulaRuntimeError(
        "NON_FINITE",
        "Formula clock must be finite.",
      );
    }
    const parser = new Parser(DATABASE_FORMULA_PARSER_OPTIONS);
    parser.functions = createDatabaseFormulaFunctions({
      nowMs,
      propertyValues,
      rowId,
    });
    parser.consts = { true: true, false: false };
    const expression = parser.parse(compilation.lowered);
    return {
      ok: true,
      value: validateDatabaseComputedValue(expression.evaluate({})),
      usesNow: compilation.usesNow,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DatabaseFormulaRuntimeError
          ? databaseComputedError(error.code, error.message)
          : databaseComputedError(
              "FORMULA_EVALUATION",
              error instanceof Error ? error.message : "Formula failed.",
            ),
      usesNow: compilation.usesNow,
    };
  }
}

/** Compiles and evaluates one formula through the production parser seam. */
export function evaluateDatabaseFormula({
  nowMs,
  properties,
  readProperty,
  rowId,
  source,
}: {
  nowMs: number;
  properties: readonly DatabaseProperty[];
  readProperty: (propertyId: string) => unknown;
  rowId: string;
  source: string;
}): DatabaseFormulaEvaluation {
  const compiled = compileDatabaseFormula(source, properties);
  if (!compiled.ok) {
    return { ok: false, error: compiled.error, usesNow: false };
  }
  return evaluateDatabaseFormulaCompilation({
    compilation: compiled.compilation,
    nowMs,
    propertyValues: compiled.compilation.propertyIds.map(readProperty),
    rowId,
  });
}
