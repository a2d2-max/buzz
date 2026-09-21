import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DATABASE_ROW_D_PREFIX,
  COMMUNITY_DATABASE_ROW_TAG,
  KIND_COMMUNITY_DATABASE_LEGACY,
  KIND_COMMUNITY_DATABASE_ROW,
} from "@/shared/constants/kinds";

import {
  compareRelayVersions,
  hasOnlyObjectKeys,
  hasTag,
  isDatabaseEntityId,
  isDatabasePubkey,
  isDocPageId,
  isFiniteNonNegativeNumber,
  parseDatabaseValues,
  singleTagValue,
  type DatabaseCellValue,
} from "./databaseValue";

export { DATABASE_MAX_CONTENT_BYTES } from "./databaseValue";

export {
  COMMUNITY_DATABASE_ROW_D_PREFIX,
  COMMUNITY_DATABASE_ROW_TAG,
  KIND_COMMUNITY_DATABASE_LEGACY,
  KIND_COMMUNITY_DATABASE_ROW,
} from "@/shared/constants/kinds";
export type {
  DatabaseCellValue,
  DatabaseDateValue,
  DatabaseFileValue,
} from "./databaseValue";

export const COMMUNITY_DATABASE_ROW_QUERY_KINDS: readonly number[] = [
  KIND_COMMUNITY_DATABASE_ROW,
  KIND_COMMUNITY_DATABASE_LEGACY,
];

export type DatabaseRowContent = {
  values: Record<string, DatabaseCellValue>;
  /** Docs page containing the row's body; `null` is the normal empty body. */
  docPageId: string | null;
  /** Original creator, persisted independently from the latest event signer. */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  deleted?: true;
};

export type DatabaseRow = Omit<DatabaseRowContent, "deleted"> & {
  id: string;
  databaseId: string;
  author: string;
  eventId: string;
  eventCreatedAt: number;
  eventKind: number;
  deleted: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validates and normalizes a decoded database-row JSON body. */
export function parseDatabaseRowContent(
  value: unknown,
): DatabaseRowContent | null {
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, [
      "values",
      "docPageId",
      "createdBy",
      "createdAt",
      "updatedAt",
      "deleted",
    ])
  )
    return null;
  const values = parseDatabaseValues(value.values);
  if (!values) return null;
  if (
    value.docPageId !== null &&
    (typeof value.docPageId !== "string" || !isDocPageId(value.docPageId))
  )
    return null;
  if (
    value.createdBy !== undefined &&
    value.createdBy !== null &&
    (typeof value.createdBy !== "string" || !isDatabasePubkey(value.createdBy))
  )
    return null;
  if (
    !isFiniteNonNegativeNumber(value.createdAt) ||
    !isFiniteNonNegativeNumber(value.updatedAt)
  )
    return null;
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") {
    return null;
  }
  return {
    values,
    docPageId: value.docPageId,
    createdBy: typeof value.createdBy === "string" ? value.createdBy : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

/** Fixed top-level key order for stable event-content bytes. */
export function serializeDatabaseRowContent(
  content: DatabaseRowContent,
): string {
  return JSON.stringify({
    values: content.values,
    docPageId: content.docPageId,
    createdBy: content.createdBy,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    ...(content.deleted === true ? { deleted: true } : {}),
  });
}

export function databaseRowDTag(id: string): string {
  return `${COMMUNITY_DATABASE_ROW_D_PREFIX}${id}`;
}

export function databaseRowIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(COMMUNITY_DATABASE_ROW_D_PREFIX)) return null;
  const id = dTag.slice(COMMUNITY_DATABASE_ROW_D_PREFIX.length);
  return isDatabaseEntityId(id) ? id : null;
}

export function newDatabaseRowId(): string {
  return crypto.randomUUID();
}

/** Builds an unsigned row event for the dedicated kind by default. */
export function buildDatabaseRowEventInput(
  row: DatabaseRowContent & { id: string; databaseId: string },
  kind:
    | typeof KIND_COMMUNITY_DATABASE_ROW
    | typeof KIND_COMMUNITY_DATABASE_LEGACY = KIND_COMMUNITY_DATABASE_ROW,
): { kind: number; content: string; tags: string[][] } {
  if (
    kind !== KIND_COMMUNITY_DATABASE_ROW &&
    kind !== KIND_COMMUNITY_DATABASE_LEGACY
  ) {
    throw new Error("Invalid database row event kind.");
  }
  if (!isDatabaseEntityId(row.id)) {
    throw new Error("Invalid row id for database row event.");
  }
  if (!isDatabaseEntityId(row.databaseId)) {
    throw new Error("Invalid database id for row event.");
  }
  const { id, databaseId, ...rawContent } = row;
  const content = parseDatabaseRowContent(rawContent);
  if (!content) {
    throw new Error("Invalid database row content.");
  }
  return {
    kind,
    content: serializeDatabaseRowContent(content),
    tags: [
      ["d", databaseRowDTag(id)],
      ["t", COMMUNITY_DATABASE_ROW_TAG],
      ["db", databaseId],
    ],
  };
}

/** UTF-8 size of the row event content that would be signed. */
export function measureDatabaseRowContentBytes(
  row: DatabaseRowContent & { id: string; databaseId: string },
): number {
  return new TextEncoder().encode(buildDatabaseRowEventInput(row).content)
    .length;
}

/** Decodes one dedicated or tagged legacy row event. */
export function parseDatabaseRowEvent(event: RelayEvent): DatabaseRow | null {
  if (
    event.kind !== KIND_COMMUNITY_DATABASE_ROW &&
    event.kind !== KIND_COMMUNITY_DATABASE_LEGACY
  )
    return null;
  const dTag = singleTagValue(event.tags, "d");
  const databaseId = singleTagValue(event.tags, "db");
  if (dTag === null || databaseId === null || !isDatabaseEntityId(databaseId))
    return null;
  if (!hasTag(event.tags, "t", COMMUNITY_DATABASE_ROW_TAG)) return null;
  const id = databaseRowIdFromDTag(dTag);
  if (id === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  const content = parseDatabaseRowContent(raw);
  if (!content) return null;
  return {
    id,
    databaseId,
    author: event.pubkey,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    eventKind: event.kind,
    values: content.values,
    docPageId: content.docPageId,
    createdBy: content.createdBy,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    deleted: content.deleted === true,
  };
}

/** Resolves row versions across authors without coupling one row to another. */
export function pickLatestDatabaseRows(
  rows: Iterable<DatabaseRow>,
): Map<string, DatabaseRow> {
  const latest = new Map<string, DatabaseRow>();
  for (const row of rows) {
    // NIP-33 replaces on (author, kind, d-tag); the `db` tag groups the row
    // but is not part of that coordinate. Across authors, resolve the same
    // dbrow id the same way so an older database tag cannot keep a ghost row.
    const current = latest.get(row.id);
    if (!current || compareRelayVersions(row, current) > 0) {
      latest.set(row.id, row);
    }
  }
  return latest;
}
