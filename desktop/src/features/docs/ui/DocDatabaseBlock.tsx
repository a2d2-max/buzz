import { AlertTriangle, Database, RotateCcw, Trash2 } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";
import { DatabaseComputedPropertyPanel } from "@/features/databases/ui/DatabaseComputedPropertyPanel";
import { useCommunityDatabasesContext } from "@/features/databases/ui/CommunityDatabasesProvider";
import { DatabaseViewSurface } from "@/features/databases/ui/DatabaseViewSurface";

export type DocDatabaseBlockProps = {
  databaseId: string;
  onRemove?: () => void;
  onSelectView: (viewId: string) => void;
  viewId: string | null;
};

/** Reuses the accepted database transport and view surface inside one Doc block. */
export function DocDatabaseBlock({
  databaseId,
  onRemove,
  onSelectView,
  viewId,
}: DocDatabaseBlockProps) {
  const databases = useCommunityDatabasesContext();
  const schema = databases.schemas.get(databaseId);
  const [lookup, setLookup] = React.useState<{
    databaseId: string;
    status: "idle" | "loading" | "missing" | "failed";
  }>({ databaseId, status: "idle" });
  const lookupStatus =
    lookup.databaseId === databaseId ? lookup.status : "idle";
  const lookupGeneration = React.useRef(0);

  const lookupMissingSchema = React.useCallback(() => {
    const generation = ++lookupGeneration.current;
    setLookup({ databaseId, status: "loading" });
    databases.lookupSchema(databaseId).then(
      (found) => {
        if (lookupGeneration.current === generation) {
          setLookup({
            databaseId,
            status: found && !found.deleted ? "idle" : "missing",
          });
        }
      },
      () => {
        if (lookupGeneration.current === generation) {
          setLookup({ databaseId, status: "failed" });
        }
      },
    );
  }, [databaseId, databases.lookupSchema]);

  React.useEffect(() => {
    if (databases.isLoading || schema || lookupStatus !== "idle") return;
    lookupMissingSchema();
  }, [databases.isLoading, lookupMissingSchema, lookupStatus, schema]);
  React.useEffect(
    () => () => {
      lookupGeneration.current += 1;
    },
    [],
  );

  const remove = onRemove ? (
    <Button onClick={onRemove} size="sm" type="button" variant="ghost">
      <Trash2 /> Remove block
    </Button>
  ) : null;

  return (
    <section
      className="my-3 overflow-hidden rounded-xl border border-border/70 bg-background"
      data-database-id={databaseId}
      data-testid={`doc-database-${databaseId}`}
    >
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{schema?.name ?? "Linked database"}</span>
        </div>
        {remove}
      </div>
      {databases.isError ? (
        <InlineNotice
          action="Reload"
          message="Couldn't load databases from the relay."
          onAction={() => void databases.refetch()}
        />
      ) : null}
      {databases.truncated ? (
        <InlineNotice
          action="Reload"
          message={`Some database history may be missing after ${databases.scanned.toLocaleString()} events.`}
          onAction={() => void databases.refetch()}
        />
      ) : null}
      {databases.isLoading || lookupStatus === "loading" ? (
        <BuzzLoadingState
          className="min-h-28"
          label="Loading linked database"
        />
      ) : lookupStatus === "failed" ? (
        <InlineNotice
          action="Retry"
          message="Couldn't check the relay for this database."
          onAction={lookupMissingSchema}
        />
      ) : !schema || schema.deleted || lookupStatus === "missing" ? (
        <InlineNotice
          action="Retry"
          message="This linked database is missing or was deleted."
          onAction={lookupMissingSchema}
        />
      ) : (
        <>
          <DatabaseComputedPropertyPanel
            lookupSchema={databases.lookupSchema}
            onSaveSchema={(id, content, baseEventId) =>
              databases.updateSchema(id, content, baseEventId)
            }
            schema={schema}
            schemas={databases.schemas}
          />
          <DatabaseViewSurface
            onAddRow={() => databases.createRow(schema.id)}
            onSaveRowValues={databases.updateRowValues}
            onSaveSchema={(content, baseEventId) =>
              databases.updateSchema(schema.id, content, baseEventId)
            }
            onSelectView={onSelectView}
            relationContext={{
              lookupRow: databases.lookupRow,
              onSaveRowValues: databases.updateRowValues,
              rows: databases.rows,
              schemas: databases.schemas,
            }}
            resolveValue={databases.resolveValue}
            rows={[...databases.rows.values()].filter(
              (row) => !row.deleted && row.databaseId === schema.id,
            )}
            schema={schema}
            viewId={viewId ?? undefined}
          />
        </>
      )}
    </section>
  );
}

/** Read-mode wrapper whose view choice is local and never rewrites Markdown. */
export function DocDatabaseReadBlock({
  databaseId,
  viewId,
}: {
  databaseId: string;
  viewId: string | null;
}) {
  return (
    <DocDatabaseReadBlockState
      databaseId={databaseId}
      key={`${databaseId}:${viewId ?? ""}`}
      viewId={viewId}
    />
  );
}

function DocDatabaseReadBlockState({
  databaseId,
  viewId,
}: {
  databaseId: string;
  viewId: string | null;
}) {
  const [selectedViewId, setSelectedViewId] = React.useState(viewId);
  return (
    <DocDatabaseBlock
      databaseId={databaseId}
      onSelectView={setSelectedViewId}
      viewId={selectedViewId}
    />
  );
}

function InlineNotice({
  action,
  message,
  onAction,
}: {
  action: string;
  message: string;
  onAction: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-3 text-xs text-amber-700"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
      <Button onClick={onAction} size="xs" type="button" variant="outline">
        <RotateCcw /> {action}
      </Button>
    </div>
  );
}
