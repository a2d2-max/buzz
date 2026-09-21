import * as React from "react";

import { createDatabaseComputedResolver } from "../lib/databaseComputedResolver";
import type { DatabaseValueResolver } from "../lib/databaseViewEngine";
import {
  type CommunityDatabases,
  useCommunityDatabases,
} from "../lib/useCommunityDatabases";
import { useDatabaseFormulaClock } from "../lib/useDatabaseFormulaClock";

export type CommunityDatabasesContextValue = CommunityDatabases & {
  resolveValue: DatabaseValueResolver;
};

const CommunityDatabasesContext =
  React.createContext<CommunityDatabasesContextValue | null>(null);

/** Owns one community database history/live subscription and computed clock. */
export function CommunityDatabasesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const databases = useCommunityDatabases();
  const nowMs = useDatabaseFormulaClock(databases.schemas);
  const computed = React.useMemo(
    () =>
      createDatabaseComputedResolver({
        nowMs,
        rowHistoryComplete: databases.rowHistoryComplete,
        rows: databases.rows,
        schemas: databases.schemas,
      }),
    [databases.rowHistoryComplete, databases.rows, databases.schemas, nowMs],
  );
  const value = React.useMemo<CommunityDatabasesContextValue>(
    () => ({ ...databases, resolveValue: computed.resolveValue }),
    [databases, computed.resolveValue],
  );
  return (
    <CommunityDatabasesContext.Provider value={value}>
      {children}
    </CommunityDatabasesContext.Provider>
  );
}

/** Reads the route-owned database snapshot and transport. */
export function useCommunityDatabasesContext(): CommunityDatabasesContextValue {
  const value = useOptionalCommunityDatabasesContext();
  if (!value) {
    throw new Error("CommunityDatabasesProvider is required.");
  }
  return value;
}

/** Reads the route context when a low-level editor test has no route owner. */
export function useOptionalCommunityDatabasesContext(): CommunityDatabasesContextValue | null {
  return React.useContext(CommunityDatabasesContext);
}
