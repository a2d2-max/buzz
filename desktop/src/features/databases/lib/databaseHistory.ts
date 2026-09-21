import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

import {
  COMMUNITY_DATABASE_ROW_QUERY_KINDS,
  type DatabaseRow,
  parseDatabaseRowEvent,
} from "./databaseRowCodec";
import {
  COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS,
  type DatabaseSchema,
  parseDatabaseSchemaEvent,
} from "./databaseSchemaCodec";

export const DATABASE_HISTORY_PAGE_LIMIT = 1_000;
export const DATABASE_HISTORY_MAX_PAGES = 30;

export type DatabaseHistoryResult<T> = {
  items: T[];
  truncated: boolean;
  scanned: number;
  newestSeen: number | undefined;
};

type DatabaseHistoryOptions<T> = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  kinds: readonly number[];
  parse: (event: RelayEvent) => T | null;
  maxPages?: number;
  pageLimit?: number;
  since?: number;
};

async function fetchDatabaseHistoryToExhaustion<T>({
  fetchEvents,
  kinds,
  maxPages = DATABASE_HISTORY_MAX_PAGES,
  pageLimit = DATABASE_HISTORY_PAGE_LIMIT,
  parse,
  since,
}: DatabaseHistoryOptions<T>): Promise<DatabaseHistoryResult<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: { until: number; beforeId: string } | undefined;
  let newestSeen: number | undefined;
  let scanned = 0;
  let truncated = false;

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await fetchEvents({
      kinds: [...kinds],
      limit: pageLimit,
      ...(since === undefined ? {} : { since }),
      ...(cursor === undefined
        ? {}
        : { until: cursor.until, before_id: cursor.beforeId }),
    });
    for (const event of batch) {
      newestSeen =
        newestSeen === undefined
          ? event.created_at
          : Math.max(newestSeen, event.created_at);
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      scanned += 1;
      const parsed = parse(event);
      if (parsed) items.push(parsed);
    }
    if (batch.length < pageLimit) break;
    const last = batch.at(-1);
    if (!last) break;
    if (
      cursor &&
      (last.created_at > cursor.until ||
        (last.created_at === cursor.until && last.id <= cursor.beforeId))
    ) {
      truncated = true;
      break;
    }
    cursor = { until: last.created_at, beforeId: last.id };
  }

  return { items, newestSeen, scanned, truncated };
}

/** Loads schema versions without post-LIMIT tag filters. */
export async function fetchDatabaseSchemasToExhaustion(
  options: Omit<DatabaseHistoryOptions<DatabaseSchema>, "kinds" | "parse">,
): Promise<
  Omit<DatabaseHistoryResult<DatabaseSchema>, "items"> & {
    schemas: DatabaseSchema[];
  }
> {
  const { items, ...result } = await fetchDatabaseHistoryToExhaustion({
    ...options,
    kinds: COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS,
    parse: parseDatabaseSchemaEvent,
  });
  return { ...result, schemas: items };
}

/** Loads row versions without post-LIMIT tag filters. */
export async function fetchDatabaseRowsToExhaustion(
  options: Omit<DatabaseHistoryOptions<DatabaseRow>, "kinds" | "parse">,
): Promise<
  Omit<DatabaseHistoryResult<DatabaseRow>, "items"> & {
    rows: DatabaseRow[];
  }
> {
  const { items, ...result } = await fetchDatabaseHistoryToExhaustion({
    ...options,
    kinds: COMMUNITY_DATABASE_ROW_QUERY_KINDS,
    parse: parseDatabaseRowEvent,
  });
  return { ...result, rows: items };
}
