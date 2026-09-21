import type { DatabaseDateValue } from "./databaseValue";

export const DATABASE_FORMULA_ERROR_CODES = [
  "SYNTAX",
  "UNSUPPORTED_FUNCTION",
  "UNKNOWN_PROPERTY",
  "AMBIGUOUS_PROPERTY",
  "TYPE_MISMATCH",
  "DIVIDE_BY_ZERO",
  "NON_FINITE",
  "CYCLE",
  "TOO_COMPLEX",
  "BROKEN_RELATION",
  "SOURCE_INCOMPLETE",
  "FORMULA_EVALUATION",
] as const;

export type DatabaseFormulaErrorCode =
  (typeof DATABASE_FORMULA_ERROR_CODES)[number];

export type DatabaseComputedError = {
  kind: "computed_error";
  code: DatabaseFormulaErrorCode;
  detail: string;
};

export type DatabaseComputedScalar =
  | null
  | string
  | number
  | boolean
  | DatabaseDateValue;

export type DatabaseComputedValue =
  | DatabaseComputedScalar
  | DatabaseComputedScalar[];

/** Returns a stable formula/rollup error object for UI and view-engine use. */
export function databaseComputedError(
  code: DatabaseFormulaErrorCode,
  detail: string,
): DatabaseComputedError {
  return { kind: "computed_error", code, detail };
}

/** True when a resolved value is an explicit computed-property failure. */
export function isDatabaseComputedError(
  value: unknown,
): value is DatabaseComputedError {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "computed_error" &&
    "code" in value &&
    typeof value.code === "string" &&
    "detail" in value &&
    typeof value.detail === "string"
  );
}

/** Stable plain-text presentation for computed values in compact surfaces. */
export function databaseComputedValueText(value: unknown): string {
  if (isDatabaseComputedError(value)) return `${value.code}: ${value.detail}`;
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(databaseComputedValueText).join(", ");
  }
  if (typeof value === "object" && "start" in value) {
    const date = value as DatabaseDateValue;
    return date.end ? `${date.start} – ${date.end}` : date.start;
  }
  if (typeof value === "object" && "url" in value) {
    const file = value as { name?: string; url: string };
    return file.name ?? file.url;
  }
  return "";
}
