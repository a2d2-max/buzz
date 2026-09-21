import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { getRelayWsUrl, signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DATABASE_ROW_TAG,
  COMMUNITY_DATABASE_SCHEMA_TAG,
  KIND_COMMUNITY_DATABASE_LEGACY,
  KIND_COMMUNITY_DATABASE_ROW,
  KIND_COMMUNITY_DATABASE_SCHEMA,
} from "@/shared/constants/kinds";
import { isUnknownKindRejection } from "@/shared/lib/dedicatedKindSupport";

import {
  databaseRowKindMarkedUnsupported,
  databaseSchemaKindMarkedUnsupported,
  markDatabaseRowKindAccepted,
  markDatabaseRowKindRejected,
  markDatabaseSchemaKindAccepted,
  markDatabaseSchemaKindRejected,
} from "./databaseKindSupport";
import {
  fetchDatabaseRowsToExhaustion,
  fetchDatabaseSchemasToExhaustion,
} from "./databaseHistory";
import {
  buildDatabaseRowEventInput,
  COMMUNITY_DATABASE_ROW_QUERY_KINDS,
  DATABASE_MAX_CONTENT_BYTES,
  type DatabaseRow,
  type DatabaseRowContent,
  databaseRowDTag,
  measureDatabaseRowContentBytes,
  newDatabaseRowId,
  parseDatabaseRowEvent,
  pickLatestDatabaseRows,
} from "./databaseRowCodec";
import {
  buildDatabaseSchemaEventInput,
  COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS,
  type DatabaseSchema,
  type DatabaseSchemaContent,
  databaseSchemaDTag,
  measureDatabaseSchemaContentBytes,
  newDatabaseId,
  parseDatabaseSchemaEvent,
  pickLatestDatabaseSchemas,
} from "./databaseSchemaCodec";
import type { DatabaseCellValue } from "./databaseValue";
import { compareRelayVersions } from "./databaseValue";

export const COMMUNITY_DATABASES_QUERY_KEY = [
  "databases",
  "community",
] as const;

type DatabaseSnapshot = {
  schemas: Map<string, DatabaseSchema>;
  rows: Map<string, DatabaseRow>;
  schemaScanned: number;
  rowScanned: number;
  schemaTruncated: boolean;
  rowTruncated: boolean;
  schemaWatermark: number | undefined;
  rowWatermark: number | undefined;
};

const EMPTY_SCHEMAS = new Map<string, DatabaseSchema>();
const EMPTY_ROWS = new Map<string, DatabaseRow>();
const EMPTY_SNAPSHOT: DatabaseSnapshot = {
  schemas: EMPTY_SCHEMAS,
  rows: EMPTY_ROWS,
  schemaScanned: 0,
  rowScanned: 0,
  schemaTruncated: false,
  rowTruncated: false,
  schemaWatermark: undefined,
  rowWatermark: undefined,
};

const INCREMENTAL_LOOKBACK_SECONDS = 2 * 900 + 60;
const SUBSCRIPTION_SETTLE_TIMEOUT_MS = 3_000;
const COORDINATE_VERSIONS_LIMIT = 200;
const MAX_CLOCK_SKEW_SECONDS = 840;

export class DatabaseConflictError extends Error {
  readonly newest: DatabaseSchema | DatabaseRow;

  constructor(newest: DatabaseSchema | DatabaseRow) {
    super("Someone else saved a newer database version.");
    this.name = "DatabaseConflictError";
    this.newest = newest;
  }
}

export class DatabaseTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `This database event is too large (${Math.ceil(bytes / 1024)} KB; the limit is ${DATABASE_MAX_CONTENT_BYTES / 1024} KB).`,
    );
    this.name = "DatabaseTooLargeError";
    this.bytes = bytes;
  }
}

export class DatabaseClockSkewError extends Error {
  constructor() {
    super(
      "The newest database version is too far in the future to edit safely.",
    );
    this.name = "DatabaseClockSkewError";
  }
}

export type CommunityDatabases = {
  schemas: Map<string, DatabaseSchema>;
  rows: Map<string, DatabaseRow>;
  isLoading: boolean;
  isError: boolean;
  truncated: boolean;
  rowHistoryComplete: boolean;
  scanned: number;
  refetch: () => Promise<unknown>;
  createDatabase: (name?: string) => Promise<DatabaseSchema>;
  createRow: (databaseId: string) => Promise<DatabaseRow>;
  updateSchema: (
    id: string,
    content: DatabaseSchemaContent,
    baseEventId: string,
  ) => Promise<DatabaseSchema>;
  updateRowValues: (
    id: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  lookupSchema: (id: string) => Promise<DatabaseSchema | undefined>;
  lookupRow: (id: string) => Promise<DatabaseRow | undefined>;
};

function nextEventCreatedAt(
  nowSeconds: number,
  lastKnownSeconds: number | undefined,
): number {
  if (lastKnownSeconds === undefined) return nowSeconds;
  const next = Math.max(nowSeconds, lastKnownSeconds + 1);
  if (next > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    throw new DatabaseClockSkewError();
  }
  return next;
}

function applyVersion<
  T extends { id: string; eventCreatedAt: number; eventId: string },
>(values: Map<string, T>, incoming: T): Map<string, T> {
  const current = values.get(incoming.id);
  if (current && compareRelayVersions(incoming, current) <= 0) return values;
  const next = new Map(values);
  next.set(incoming.id, incoming);
  return next;
}

async function publishWithFallback<T>({
  dedicatedKind,
  legacyKind,
  markedUnsupported,
  markAccepted,
  markRejected,
  publishAs,
}: {
  dedicatedKind: number;
  legacyKind: number;
  markedUnsupported: (relayUrl: string, nowMs: number) => boolean;
  markAccepted: (relayUrl: string) => void;
  markRejected: (relayUrl: string, nowMs: number) => void;
  publishAs: (kind: number) => Promise<T>;
}): Promise<T> {
  const relayUrl = await getRelayWsUrl().catch(() => null);
  if (relayUrl && markedUnsupported(relayUrl, Date.now())) {
    return publishAs(legacyKind);
  }
  try {
    const result = await publishAs(dedicatedKind);
    if (relayUrl) markAccepted(relayUrl);
    return result;
  } catch (error) {
    if (!isUnknownKindRejection(error)) throw error;
    if (relayUrl) markRejected(relayUrl, Date.now());
    return publishAs(legacyKind);
  }
}

function mergeWatermark(
  previous: number | undefined,
  next: number | undefined,
): number | undefined {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  return Math.max(previous, next);
}

export function useCommunityDatabases(): CommunityDatabases {
  const queryClient = useQueryClient();
  const identityQuery = useIdentityQuery();
  const historyLoadedRef = React.useRef(false);
  const [subscriptionsSettled, setSubscriptionsSettled] = React.useState(false);

  const query = useQuery({
    queryKey: COMMUNITY_DATABASES_QUERY_KEY,
    enabled: subscriptionsSettled,
    queryFn: async (): Promise<DatabaseSnapshot> => {
      const previous = queryClient.getQueryData<DatabaseSnapshot>(
        COMMUNITY_DATABASES_QUERY_KEY,
      );
      const schemaSince =
        previous?.schemaWatermark !== undefined && !previous.schemaTruncated
          ? Math.max(0, previous.schemaWatermark - INCREMENTAL_LOOKBACK_SECONDS)
          : undefined;
      const rowSince =
        previous?.rowWatermark !== undefined && !previous.rowTruncated
          ? Math.max(0, previous.rowWatermark - INCREMENTAL_LOOKBACK_SECONDS)
          : undefined;
      let [schemaHistory, rowHistory] = await Promise.all([
        fetchDatabaseSchemasToExhaustion({
          fetchEvents: (filter) => relayClient.fetchEvents(filter),
          since: schemaSince,
        }),
        fetchDatabaseRowsToExhaustion({
          fetchEvents: (filter) => relayClient.fetchEvents(filter),
          since: rowSince,
        }),
      ]);
      if (schemaSince !== undefined && schemaHistory.truncated) {
        schemaHistory = await fetchDatabaseSchemasToExhaustion({
          fetchEvents: (filter) => relayClient.fetchEvents(filter),
        });
      }
      if (rowSince !== undefined && rowHistory.truncated) {
        rowHistory = await fetchDatabaseRowsToExhaustion({
          fetchEvents: (filter) => relayClient.fetchEvents(filter),
        });
      }
      const cached = queryClient.getQueryData<DatabaseSnapshot>(
        COMMUNITY_DATABASES_QUERY_KEY,
      );
      historyLoadedRef.current = true;
      return {
        schemas: pickLatestDatabaseSchemas([
          ...(cached?.schemas.values() ?? []),
          ...schemaHistory.schemas,
        ]),
        rows: pickLatestDatabaseRows([
          ...(cached?.rows.values() ?? []),
          ...rowHistory.rows,
        ]),
        schemaScanned: schemaHistory.scanned,
        rowScanned: rowHistory.scanned,
        schemaTruncated: schemaHistory.truncated,
        rowTruncated: rowHistory.truncated,
        schemaWatermark: schemaHistory.truncated
          ? undefined
          : mergeWatermark(previous?.schemaWatermark, schemaHistory.newestSeen),
        rowWatermark: rowHistory.truncated
          ? undefined
          : mergeWatermark(previous?.rowWatermark, rowHistory.newestSeen),
      };
    },
    staleTime: 60_000,
  });

  const applySchema = React.useCallback(
    (schema: DatabaseSchema) => {
      queryClient.setQueryData<DatabaseSnapshot>(
        COMMUNITY_DATABASES_QUERY_KEY,
        (previous) => {
          const current = previous ?? EMPTY_SNAPSHOT;
          const schemas = applyVersion(current.schemas, schema);
          return schemas === current.schemas
            ? current
            : { ...current, schemas };
        },
        { updatedAt: historyLoadedRef.current ? Date.now() : 0 },
      );
    },
    [queryClient],
  );
  const applyRow = React.useCallback(
    (row: DatabaseRow) => {
      queryClient.setQueryData<DatabaseSnapshot>(
        COMMUNITY_DATABASES_QUERY_KEY,
        (previous) => {
          const current = previous ?? EMPTY_SNAPSHOT;
          const rows = applyVersion(current.rows, row);
          return rows === current.rows ? current : { ...current, rows };
        },
        { updatedAt: historyLoadedRef.current ? Date.now() : 0 },
      );
    },
    [queryClient],
  );

  React.useEffect(() => {
    let cancelled = false;
    const stops: Array<() => Promise<void>> = [];
    const settled = new Set<string>();
    const settle = (lane: string) => {
      if (settled.has(lane)) return;
      settled.add(lane);
      if (!cancelled && settled.size === 2) setSubscriptionsSettled(true);
    };
    const timer = window.setTimeout(
      () => setSubscriptionsSettled(true),
      SUBSCRIPTION_SETTLE_TIMEOUT_MS,
    );
    const subscribe = (
      lane: string,
      filter: { kinds: number[]; "#t": string[]; limit: number },
      onEvent: (event: RelayEvent) => void,
    ) => {
      void relayClient
        .subscribeLive(filter, onEvent, () => settle(lane))
        .then((stop) => {
          if (cancelled) void stop();
          else stops.push(stop);
          settle(lane);
        })
        .catch(() => settle(lane));
    };
    subscribe(
      "schemas",
      {
        kinds: [...COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS],
        "#t": [COMMUNITY_DATABASE_SCHEMA_TAG],
        limit: 0,
      },
      (event) => {
        const schema = parseDatabaseSchemaEvent(event);
        if (!cancelled && schema) applySchema(schema);
      },
    );
    subscribe(
      "rows",
      {
        kinds: [...COMMUNITY_DATABASE_ROW_QUERY_KINDS],
        "#t": [COMMUNITY_DATABASE_ROW_TAG],
        limit: 0,
      },
      (event) => {
        const row = parseDatabaseRowEvent(event);
        if (!cancelled && row) applyRow(row);
      },
    );
    const unsubscribeReconnect = relayClient.subscribeToReconnects(() => {
      if (cancelled) return;
      void queryClient.invalidateQueries({
        queryKey: COMMUNITY_DATABASES_QUERY_KEY,
      });
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribeReconnect();
      for (const stop of stops) void stop();
    };
  }, [applyRow, applySchema, queryClient]);

  const readSnapshot = React.useCallback(
    () =>
      queryClient.getQueryData<DatabaseSnapshot>(
        COMMUNITY_DATABASES_QUERY_KEY,
      ) ?? EMPTY_SNAPSHOT,
    [queryClient],
  );

  const fetchNewestSchema = React.useCallback(
    async (id: string) => {
      const events = await relayClient.fetchEvents({
        kinds: [...COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS],
        "#d": [databaseSchemaDTag(id)],
        limit: COORDINATE_VERSIONS_LIMIT,
      });
      const versions = events
        .map(parseDatabaseSchemaEvent)
        .filter((value): value is DatabaseSchema => value?.id === id);
      const cached = readSnapshot().schemas.get(id);
      const newest = pickLatestDatabaseSchemas(
        cached ? [cached, ...versions] : versions,
      ).get(id);
      if (newest) applySchema(newest);
      return newest;
    },
    [applySchema, readSnapshot],
  );

  const fetchNewestRow = React.useCallback(
    async (id: string) => {
      const events = await relayClient.fetchEvents({
        kinds: [...COMMUNITY_DATABASE_ROW_QUERY_KINDS],
        "#d": [databaseRowDTag(id)],
        limit: COORDINATE_VERSIONS_LIMIT,
      });
      const versions = events
        .map(parseDatabaseRowEvent)
        .filter((value): value is DatabaseRow => value?.id === id);
      const cached = readSnapshot().rows.get(id);
      const newest = pickLatestDatabaseRows(
        cached ? [cached, ...versions] : versions,
      ).get(id);
      if (newest) applyRow(newest);
      return newest;
    },
    [applyRow, readSnapshot],
  );

  const publishSchemaAs = React.useCallback(
    async (
      content: DatabaseSchemaContent & { id: string },
      kind:
        | typeof KIND_COMMUNITY_DATABASE_SCHEMA
        | typeof KIND_COMMUNITY_DATABASE_LEGACY,
      known?: DatabaseSchema,
    ) => {
      const bytes = measureDatabaseSchemaContentBytes(content);
      if (bytes > DATABASE_MAX_CONTENT_BYTES)
        throw new DatabaseTooLargeError(bytes);
      const event = await signRelayEvent({
        ...buildDatabaseSchemaEventInput(content, kind),
        createdAt: nextEventCreatedAt(
          Math.floor(Date.now() / 1_000),
          known?.eventCreatedAt,
        ),
      });
      const schema = parseDatabaseSchemaEvent(event);
      if (!schema)
        throw new Error("Signed database schema did not round-trip.");
      await relayClient.publishEvent(
        event,
        "Timed out publishing the database schema.",
        "Failed to publish the database schema.",
      );
      applySchema(schema);
      return schema;
    },
    [applySchema],
  );

  const publishSchema = React.useCallback(
    (content: DatabaseSchemaContent & { id: string }, known?: DatabaseSchema) =>
      publishWithFallback({
        dedicatedKind: KIND_COMMUNITY_DATABASE_SCHEMA,
        legacyKind: KIND_COMMUNITY_DATABASE_LEGACY,
        markedUnsupported: databaseSchemaKindMarkedUnsupported,
        markAccepted: markDatabaseSchemaKindAccepted,
        markRejected: markDatabaseSchemaKindRejected,
        publishAs: (kind) =>
          publishSchemaAs(
            content,
            kind as
              | typeof KIND_COMMUNITY_DATABASE_SCHEMA
              | typeof KIND_COMMUNITY_DATABASE_LEGACY,
            known,
          ),
      }),
    [publishSchemaAs],
  );

  const publishRowAs = React.useCallback(
    async (
      content: DatabaseRowContent & { id: string; databaseId: string },
      kind:
        | typeof KIND_COMMUNITY_DATABASE_ROW
        | typeof KIND_COMMUNITY_DATABASE_LEGACY,
      known?: DatabaseRow,
    ) => {
      const bytes = measureDatabaseRowContentBytes(content);
      if (bytes > DATABASE_MAX_CONTENT_BYTES)
        throw new DatabaseTooLargeError(bytes);
      const event = await signRelayEvent({
        ...buildDatabaseRowEventInput(content, kind),
        createdAt: nextEventCreatedAt(
          Math.floor(Date.now() / 1_000),
          known?.eventCreatedAt,
        ),
      });
      const row = parseDatabaseRowEvent(event);
      if (!row) throw new Error("Signed database row did not round-trip.");
      if (content.createdBy && row.author !== content.createdBy && !known) {
        throw new Error("The signing identity changed while creating the row.");
      }
      await relayClient.publishEvent(
        event,
        "Timed out publishing the database row.",
        "Failed to publish the database row.",
      );
      applyRow(row);
      return row;
    },
    [applyRow],
  );

  const publishRow = React.useCallback(
    (
      content: DatabaseRowContent & { id: string; databaseId: string },
      known?: DatabaseRow,
    ) =>
      publishWithFallback({
        dedicatedKind: KIND_COMMUNITY_DATABASE_ROW,
        legacyKind: KIND_COMMUNITY_DATABASE_LEGACY,
        markedUnsupported: databaseRowKindMarkedUnsupported,
        markAccepted: markDatabaseRowKindAccepted,
        markRejected: markDatabaseRowKindRejected,
        publishAs: (kind) =>
          publishRowAs(
            content,
            kind as
              | typeof KIND_COMMUNITY_DATABASE_ROW
              | typeof KIND_COMMUNITY_DATABASE_LEGACY,
            known,
          ),
      }),
    [publishRowAs],
  );

  const createDatabase = React.useCallback<
    CommunityDatabases["createDatabase"]
  >(
    (name = "Untitled database") => {
      const now = Date.now();
      return publishSchema({
        id: newDatabaseId(),
        name: name.trim() || "Untitled database",
        properties: [{ id: "title", name: "Name", type: "title" }],
        views: [
          {
            id: "table",
            name: "Table",
            type: "table",
            sorts: [],
            visiblePropertyIds: ["title"],
            propertyWidths: { title: 280 },
          },
        ],
        createdAt: now,
        updatedAt: now,
      });
    },
    [publishSchema],
  );

  const createRow = React.useCallback<CommunityDatabases["createRow"]>(
    async (databaseId) => {
      const schema = await fetchNewestSchema(databaseId);
      if (!schema || schema.deleted)
        throw new Error("This database no longer exists.");
      const creator = identityQuery.data?.pubkey?.trim().toLowerCase();
      if (!creator) throw new Error("Your signing identity is not available.");
      const title = schema.properties.find(
        (property) => property.type === "title",
      );
      if (!title) throw new Error("This database has no title property.");
      const now = Date.now();
      return publishRow({
        id: newDatabaseRowId(),
        databaseId,
        values: { [title.id]: "" },
        docPageId: null,
        createdBy: creator,
        createdAt: now,
        updatedAt: now,
      });
    },
    [fetchNewestSchema, identityQuery.data?.pubkey, publishRow],
  );

  const updateSchema = React.useCallback<CommunityDatabases["updateSchema"]>(
    async (id, content, baseEventId) => {
      const newest = await fetchNewestSchema(id);
      if (!newest || newest.deleted)
        throw new Error("This database no longer exists.");
      if (newest.eventId !== baseEventId)
        throw new DatabaseConflictError(newest);
      return publishSchema(
        {
          ...content,
          id,
          createdAt: newest.createdAt,
          updatedAt: Date.now(),
          deleted: undefined,
        },
        newest,
      );
    },
    [fetchNewestSchema, publishSchema],
  );

  const updateRowValues = React.useCallback<
    CommunityDatabases["updateRowValues"]
  >(
    async (id, values, baseEventId) => {
      const newest = await fetchNewestRow(id);
      if (!newest || newest.deleted)
        throw new Error("This database row no longer exists.");
      if (newest.eventId !== baseEventId)
        throw new DatabaseConflictError(newest);
      return publishRow(
        {
          id,
          databaseId: newest.databaseId,
          values,
          docPageId: newest.docPageId,
          createdBy: newest.createdBy,
          createdAt: newest.createdAt,
          updatedAt: Date.now(),
        },
        newest,
      );
    },
    [fetchNewestRow, publishRow],
  );

  const snapshot = query.data ?? EMPTY_SNAPSHOT;
  return {
    schemas: snapshot.schemas,
    rows: snapshot.rows,
    isLoading: query.isPending,
    isError: query.isError,
    truncated: snapshot.schemaTruncated || snapshot.rowTruncated,
    rowHistoryComplete: !snapshot.rowTruncated,
    scanned: snapshot.schemaScanned + snapshot.rowScanned,
    refetch: query.refetch,
    createDatabase,
    createRow,
    updateSchema,
    updateRowValues,
    lookupSchema: fetchNewestSchema,
    lookupRow: fetchNewestRow,
  };
}
