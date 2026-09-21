/** A Notion-style date cell. Date-only values use YYYY-MM-DD strings. */
export type DatabaseDateValue = {
  start: string;
  end?: string;
  includeTime: boolean;
};

/** A relay media or external file reference stored in a files cell. */
export type DatabaseFileValue = {
  url: string;
  name?: string;
};

/**
 * Wire-safe values stored under a database row's property ids.
 *
 * Select-like values are option ids (`string`); multi-select, person, and
 * relation values are id arrays. Formula and rollup results use the matching
 * scalar shape. Property-aware editing validates the narrower meaning.
 */
export type DatabaseCellValue =
  | null
  | string
  | number
  | boolean
  | string[]
  | DatabaseDateValue
  | DatabaseFileValue[];

/** Relay event-content ceiling shared with Docs and relay ingest. */
export const DATABASE_MAX_CONTENT_BYTES = 256 * 1024;

const PROPERTY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

export function isDatabasePropertyId(value: string): boolean {
  return PROPERTY_ID_PATTERN.test(value);
}

export function isDocPageId(value: string): boolean {
  return PAGE_ID_PATTERN.test(value);
}

export function isDatabaseEntityId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** True for the normalized lowercase hex form used by Nostr pubkeys. */
export function isDatabasePubkey(value: string): boolean {
  return PUBKEY_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when a decoded JSON object contains no fields outside its wire shape. */
export function hasOnlyObjectKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Returns a normalized cell value, or `undefined` for an unsupported shape. */
export function parseDatabaseCellValue(
  value: unknown,
): DatabaseCellValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return [...value];
    }
    const files: DatabaseFileValue[] = [];
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        !hasOnlyObjectKeys(entry, ["url", "name"]) ||
        typeof entry.url !== "string"
      )
        return undefined;
      if (entry.name !== undefined && typeof entry.name !== "string") {
        return undefined;
      }
      files.push({
        url: entry.url,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      });
    }
    return files;
  }
  if (!isRecord(value) || typeof value.start !== "string") return undefined;
  if (!hasOnlyObjectKeys(value, ["start", "end", "includeTime"])) {
    return undefined;
  }
  if (value.end !== undefined && typeof value.end !== "string")
    return undefined;
  if (typeof value.includeTime !== "boolean") return undefined;
  return {
    start: value.start,
    ...(typeof value.end === "string" ? { end: value.end } : {}),
    includeTime: value.includeTime,
  };
}

/** Validates and copies the property-id to cell-value map from one row. */
export function parseDatabaseValues(
  value: unknown,
): Record<string, DatabaseCellValue> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 1_000) return null;
  const parsed: Array<[string, DatabaseCellValue]> = [];
  for (const [propertyId, raw] of entries) {
    if (!isDatabasePropertyId(propertyId)) return null;
    const cell = parseDatabaseCellValue(raw);
    if (cell === undefined) return null;
    parsed.push([propertyId, cell]);
  }
  return Object.fromEntries(parsed);
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function singleTagValue(tags: string[][], name: string): string | null {
  const matching = tags.filter((tag) => tag[0] === name);
  if (matching.length !== 1) return null;
  return typeof matching[0][1] === "string" ? matching[0][1] : null;
}

export function hasTag(tags: string[][], name: string, value: string): boolean {
  return tags.some((tag) => tag[0] === name && tag[1] === value);
}

export function compareRelayVersions(
  a: { eventCreatedAt: number; eventId: string },
  b: { eventCreatedAt: number; eventId: string },
): number {
  if (a.eventCreatedAt !== b.eventCreatedAt) {
    return a.eventCreatedAt - b.eventCreatedAt;
  }
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}
