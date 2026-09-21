import { AlertTriangle, Database, Plus, RotateCcw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { Button } from "@/shared/ui/button";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";
import { Input } from "@/shared/ui/input";

import type {
  DatabaseSchema,
  DatabaseSchemaContent,
} from "../lib/databaseSchemaCodec";
import { compareRelayVersions } from "../lib/databaseValue";
import { DatabaseConflictError } from "../lib/useCommunityDatabases";
import {
  CommunityDatabasesProvider,
  useCommunityDatabasesContext,
} from "./CommunityDatabasesProvider";
import { DatabaseViewSurface } from "./DatabaseViewSurface";
import { DatabaseComputedPropertyPanel } from "./DatabaseComputedPropertyPanel";

type DatabasesScreenProps = {
  /** Database selected by the route; undefined on the bare overview. */
  databaseId?: string;
  /** Saved database view selected by the route search. */
  viewId?: string;
};

function editableSchemaContent(schema: DatabaseSchema): DatabaseSchemaContent {
  return {
    name: schema.name,
    ...(schema.icon ? { icon: schema.icon } : {}),
    properties: schema.properties,
    views: schema.views,
    createdAt: schema.createdAt,
    updatedAt: schema.updatedAt,
  };
}

function DatabaseNameEditor({
  schema,
  onSave,
}: {
  schema: DatabaseSchema;
  onSave: (
    content: DatabaseSchemaContent,
    baseEventId: string,
  ) => Promise<DatabaseSchema>;
}) {
  const [name, setName] = React.useState(schema.name);
  const [failure, setFailure] = React.useState<{
    name: string;
    baseSchema: DatabaseSchema;
    content: DatabaseSchemaContent;
    baseEventId: string;
    message: string;
  } | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const acceptedSchemaRef = React.useRef(schema);

  React.useEffect(() => {
    if (compareRelayVersions(schema, acceptedSchemaRef.current) < 0) return;
    acceptedSchemaRef.current = schema;
    if (failure) {
      if (
        failure.baseEventId !== schema.eventId &&
        compareRelayVersions(schema, failure.baseSchema) > 0
      ) {
        setFailure({
          ...failure,
          baseSchema: schema,
          baseEventId: schema.eventId,
          content: {
            ...editableSchemaContent(schema),
            name: failure.name,
          },
          message:
            "A newer database schema was loaded. Retry to apply your name to it.",
        });
      }
      setName(failure.name);
      return;
    }
    if (!dirty) setName(schema.name);
  }, [dirty, failure, schema]);

  const save = async (
    intendedName = name.trim() || "Untitled database",
    baseSchema = acceptedSchemaRef.current,
  ) => {
    if (saving) return;
    if (intendedName === baseSchema.name && !failure) {
      setName(baseSchema.name);
      setDirty(false);
      return;
    }
    const content = {
      ...editableSchemaContent(baseSchema),
      name: intendedName,
    };
    setSaving(true);
    setFailure(null);
    try {
      const saved = await onSave(content, baseSchema.eventId);
      acceptedSchemaRef.current = saved;
      setName(saved.name);
      setDirty(false);
    } catch (error) {
      const newest =
        error instanceof DatabaseConflictError && "properties" in error.newest
          ? error.newest
          : baseSchema;
      acceptedSchemaRef.current = newest;
      setFailure({
        name: intendedName,
        baseSchema: newest,
        content: {
          ...editableSchemaContent(newest),
          name: intendedName,
        },
        baseEventId: newest.eventId,
        message:
          newest !== baseSchema
            ? "A newer database schema was loaded. Retry to apply your name to it."
            : error instanceof Error
              ? error.message
              : "Couldn't rename this database.",
      });
      setName(intendedName);
      setDirty(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input
        aria-label="Database name"
        className="h-9 min-w-40 max-w-xl border-transparent bg-transparent px-2 text-lg font-semibold hover:border-input/40 focus:border-input"
        disabled={saving}
        onBlur={() => {
          if (!failure) void save();
        }}
        onChange={(event) => {
          setName(event.target.value);
          setDirty(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape") {
            setName(acceptedSchemaRef.current.name);
            setFailure(null);
            setDirty(false);
            event.currentTarget.blur();
          }
        }}
        value={name}
      />
      {failure ? (
        <div
          className="flex items-center gap-2 text-xs text-destructive"
          role="alert"
        >
          <span>{failure.message}</span>
          <Button
            aria-label="Retry database name"
            disabled={saving}
            onClick={() =>
              void save(
                failure.name,
                schema.eventId === failure.baseEventId
                  ? schema
                  : failure.baseSchema,
              )
            }
            size="xs"
            type="button"
            variant="outline"
          >
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DatabasesScreenContent({ databaseId, viewId }: DatabasesScreenProps) {
  const databases = useCommunityDatabasesContext();
  const { goDatabases } = useAppNavigation();
  const selected = databaseId ? databases.schemas.get(databaseId) : undefined;
  const [lookup, setLookup] = React.useState<{
    id: string;
    status: "answered" | "failed";
  } | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const lookupStatus = lookup?.id === databaseId ? lookup?.status : null;
  const needsLookup =
    Boolean(databaseId) &&
    !databases.isLoading &&
    !selected &&
    lookupStatus === null;

  React.useEffect(() => {
    if (!databaseId || !needsLookup) return;
    let cancelled = false;
    databases.lookupSchema(databaseId).then(
      () => {
        if (!cancelled) setLookup({ id: databaseId, status: "answered" });
      },
      (error: unknown) => {
        console.warn("[databases] database lookup failed", error);
        if (!cancelled) setLookup({ id: databaseId, status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [databaseId, databases.lookupSchema, needsLookup]);

  const activeSchemas = React.useMemo(
    () =>
      [...databases.schemas.values()]
        .filter((schema) => !schema.deleted)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [databases.schemas],
  );
  const rows = React.useMemo(
    () =>
      [...databases.rows.values()]
        .filter((row) => !row.deleted && row.databaseId === selected?.id)
        .sort((left, right) => left.createdAt - right.createdAt),
    [databases.rows, selected?.id],
  );

  const createDatabase = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await databases.createDatabase();
      await goDatabases(created.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Couldn't create a database.";
      setCreateError(message);
      toast.error("Couldn't create the database.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
      data-testid="databases-screen"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/60">
        <TopChromeInsetHeader flush>
          <div className="flex min-h-9 items-center gap-2 px-4 py-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Databases</span>
          </div>
        </TopChromeInsetHeader>
        {databases.truncated ? (
          <div
            className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
            data-testid="databases-truncated"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>
              Some databases may be missing after checking{" "}
              {databases.scanned.toLocaleString()} events.{" "}
              <button
                className="underline underline-offset-2"
                onClick={() => void databases.refetch()}
                type="button"
              >
                Reload
              </button>
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {databases.isLoading ? (
            <BuzzLoadingState label="Loading databases" />
          ) : (
            <div className="flex flex-col gap-1">
              {activeSchemas.map((schema) => (
                <button
                  aria-current={schema.id === selected?.id ? "page" : undefined}
                  className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted/60 aria-[current=page]:bg-muted"
                  data-testid={`database-nav-${schema.id}`}
                  key={schema.id}
                  onClick={() => void goDatabases(schema.id)}
                  type="button"
                >
                  <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {schema.icon ? `${schema.icon} ` : ""}
                    {schema.name}
                  </span>
                </button>
              ))}
              {!activeSchemas.length && !databases.isError ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No databases yet.
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="border-t border-border/60 p-2">
          <Button
            className="w-full justify-start"
            disabled={creating}
            onClick={() => void createDatabase()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus /> {creating ? "Creating…" : "New database"}
          </Button>
          {createError ? (
            <p className="px-2 pt-1 text-xs text-destructive" role="alert">
              {createError}
            </p>
          ) : null}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {selected && !selected.deleted ? (
          <>
            <TopChromeInsetHeader flush>
              <div className="flex min-h-14 items-center px-4 py-2">
                <DatabaseNameEditor
                  onSave={(content, baseEventId) =>
                    databases.updateSchema(selected.id, content, baseEventId)
                  }
                  schema={selected}
                />
              </div>
            </TopChromeInsetHeader>
            <DatabaseComputedPropertyPanel
              key={`computed:${selected.id}`}
              lookupSchema={databases.lookupSchema}
              onSaveSchema={(id, content, baseEventId) =>
                databases.updateSchema(id, content, baseEventId)
              }
              schema={selected}
              schemas={databases.schemas}
            />
            <DatabaseViewSurface
              key={`view:${selected.id}`}
              onAddRow={() => databases.createRow(selected.id)}
              onSaveRowValues={databases.updateRowValues}
              onSaveSchema={(content, baseEventId) =>
                databases.updateSchema(selected.id, content, baseEventId)
              }
              rows={rows}
              schema={selected}
              resolveValue={databases.resolveValue}
              relationContext={{
                lookupRow: databases.lookupRow,
                onSaveRowValues: databases.updateRowValues,
                rows: databases.rows,
                schemas: databases.schemas,
              }}
              viewId={viewId}
              onSelectView={(nextViewId) =>
                void goDatabases(selected.id, {
                  replace: true,
                  viewId: nextViewId,
                })
              }
            />
          </>
        ) : (
          <DatabasePlaceholder
            isError={databases.isError}
            isLoading={databases.isLoading || needsLookup}
            lookupFailed={lookupStatus === "failed"}
            missingDatabase={lookupStatus === "answered"}
            onBack={() => void goDatabases(null)}
            onCreate={() => void createDatabase()}
            onRetry={() => void databases.refetch()}
            onRetryLookup={() => setLookup(null)}
          />
        )}
      </section>
    </div>
  );
}

/** Full-page database route with one shared community data provider. */
export function DatabasesScreen(props: DatabasesScreenProps) {
  return (
    <CommunityDatabasesProvider>
      <DatabasesScreenContent {...props} />
    </CommunityDatabasesProvider>
  );
}

function DatabasePlaceholder({
  isError,
  isLoading,
  lookupFailed,
  missingDatabase,
  onBack,
  onCreate,
  onRetry,
  onRetryLookup,
}: {
  isError: boolean;
  isLoading: boolean;
  lookupFailed: boolean;
  missingDatabase: boolean;
  onBack: () => void;
  onCreate: () => void;
  onRetry: () => void;
  onRetryLookup: () => void;
}) {
  if (isLoading) return <BuzzLoadingState fill label="Loading database" />;
  const action = lookupFailed
    ? { label: "Try again", run: onRetryLookup }
    : isError
      ? { label: "Reload", run: onRetry }
      : missingDatabase
        ? { label: "Back to databases", run: onBack }
        : { label: "Create database", run: onCreate };
  const message = lookupFailed
    ? "Couldn't check the relay for this database."
    : isError
      ? "Couldn't load databases from the relay."
      : missingDatabase
        ? "This database doesn't exist or was deleted."
        : "Create a shared table for this community.";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
        <Database className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button onClick={action.run} size="sm" type="button" variant="outline">
        {action.label}
      </Button>
    </div>
  );
}
