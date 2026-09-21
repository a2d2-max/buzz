import {
  isDatabaseEntityId,
  isDatabasePropertyId,
} from "@/features/databases/lib/databaseValue";

export type DocDatabaseDirective = {
  databaseId: string;
  viewId: string | null;
};

/** Parses one exact, standalone, column-zero Docs database directive line. */
export function parseDocDatabaseDirectiveLine(
  rawLine: string,
): DocDatabaseDirective | null {
  const parts = rawLine.split(" ");
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => part.length === 0) ||
    parts[0] !== ":::db" ||
    !isDatabaseEntityId(parts[1]) ||
    (parts.length === 3 && !isDatabasePropertyId(parts[2]))
  ) {
    return null;
  }
  return {
    databaseId: parts[1],
    viewId: parts[2] ?? null,
  };
}

/** Serializes a validated database reference to the canonical directive. */
export function serializeDocDatabaseDirective(
  directive: DocDatabaseDirective,
): string {
  const parsed = parseDocDatabaseDirectiveLine(
    `:::db ${directive.databaseId}${directive.viewId ? ` ${directive.viewId}` : ""}`,
  );
  if (!parsed) throw new Error("Invalid Docs database directive.");
  return `:::db ${parsed.databaseId}${parsed.viewId ? ` ${parsed.viewId}` : ""}`;
}

/** Conservatively protects database references, including source-mode examples. */
export function hasDocDatabaseDirective(body: string): boolean {
  return body
    .split(/\r?\n/)
    .some((line) => parseDocDatabaseDirectiveLine(line) !== null);
}

/** Conversion must retain every existing database/view reference, including duplicates. */
export function preservesDocDatabaseDirectives(
  before: string,
  after: string,
): boolean {
  const remaining = new Map<string, number>();
  for (const line of after.split(/\r?\n/)) {
    const parsed = parseDocDatabaseDirectiveLine(line);
    if (parsed) {
      const key = serializeDocDatabaseDirective(parsed);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
  }
  for (const line of before.split(/\r?\n/)) {
    const parsed = parseDocDatabaseDirectiveLine(line);
    if (!parsed) continue;
    const key = serializeDocDatabaseDirective(parsed);
    const count = remaining.get(key) ?? 0;
    if (!count) return false;
    remaining.set(key, count - 1);
  }
  return true;
}
