import type {
  DatabaseComputedResultType,
  DatabaseProperty,
} from "./databaseSchemaCodec";
import { databaseDateValueMatches } from "./databaseDateValue";

export type DatabaseComputedScalarType = "number" | "text" | "boolean" | "date";

/** Returns persisted computed output metadata, or unknown for older schemas. */
export function databasePropertyComputedResultType(
  property: DatabaseProperty,
): DatabaseComputedResultType | "unknown" {
  return property.type === "formula" || property.type === "rollup"
    ? (property.options.resultType ?? "unknown")
    : "unknown";
}

/** True when a computed output is a homogeneous list of the declared scalar. */
export function databaseComputedResultIsList(
  resultType: DatabaseComputedResultType | "unknown",
): boolean {
  return resultType.endsWith("_list");
}

/** Returns the scalar value type used by filter editors for a computed output. */
export function databaseComputedScalarType(
  resultType: DatabaseComputedResultType | "unknown",
): DatabaseComputedScalarType | "unknown" {
  switch (resultType) {
    case "number_list":
      return "number";
    case "text_list":
      return "text";
    case "boolean_list":
      return "boolean";
    case "date_list":
      return "date";
    default:
      return resultType;
  }
}

/** Maps a raw property to the scalar type produced by a show rollup. */
export function databasePropertyScalarType(
  property: DatabaseProperty,
): DatabaseComputedScalarType | "unknown" {
  if (["number", "created_time", "last_edited_time"].includes(property.type)) {
    return "number";
  }
  if (property.type === "checkbox") return "boolean";
  if (property.type === "date") return "date";
  if (property.type === "formula" || property.type === "rollup") {
    const resultType = databasePropertyComputedResultType(property);
    return databaseComputedResultIsList(resultType)
      ? "unknown"
      : databaseComputedScalarType(resultType);
  }
  if (["multi_select", "person", "relation", "files"].includes(property.type)) {
    return "unknown";
  }
  return "text";
}

/** Validates a computed value against its persisted scalar/list contract. */
export function databaseComputedValueMatchesResultType(
  value: unknown,
  resultType: DatabaseComputedResultType | "unknown",
): boolean {
  if (resultType === "unknown" || value === null) return true;
  const scalarType = databaseComputedScalarType(resultType);
  const scalarMatches = (candidate: unknown): boolean => {
    if (candidate === null) return true;
    if (scalarType === "number") {
      return typeof candidate === "number" && Number.isFinite(candidate);
    }
    if (scalarType === "boolean") return typeof candidate === "boolean";
    if (scalarType === "text") return typeof candidate === "string";
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      "start" in candidate &&
      "includeTime" in candidate &&
      databaseDateValueMatches(
        candidate as {
          start: string;
          end?: string;
          includeTime: boolean;
        },
      )
    );
  };
  return databaseComputedResultIsList(resultType)
    ? Array.isArray(value) && value.every(scalarMatches)
    : !Array.isArray(value) && scalarMatches(value);
}
