import type { DatabaseRow } from "./databaseRowCodec";
import type { DatabaseProperty } from "./databaseSchemaCodec";
import { isDatabasePubkey, type DatabaseCellValue } from "./databaseValue";

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Builds the single full-row snapshot for one accepted board move. */
export function buildDatabaseBoardDropValues({
  row,
  property,
  source,
  target,
}: {
  row: DatabaseRow;
  property: DatabaseProperty;
  source: string | null;
  target: string | null;
}): Record<string, DatabaseCellValue> | null {
  if (source === target) return null;
  if (property.type === "select" || property.type === "status") {
    if (
      target !== null &&
      !property.options.choices.some((choice) => choice.id === target)
    ) {
      return null;
    }
    const current = row.values[property.id] ?? null;
    if (current === target) return null;
    return { ...row.values, [property.id]: target };
  }
  if (property.type !== "person") return null;
  if (target !== null && !isDatabasePubkey(target)) return null;
  if (source !== null && !isDatabasePubkey(source)) return null;
  const current = row.values[property.id];
  const people =
    Array.isArray(current) &&
    current.every((value) => typeof value === "string")
      ? (current as string[])
      : null;
  if (
    source === null
      ? people !== null && people.length > 0
      : people === null || !people.includes(source)
  ) {
    return null;
  }
  const next = target === null ? [] : [target];
  if (people !== null && arraysEqual(people, next)) {
    return null;
  }
  return { ...row.values, [property.id]: next };
}
