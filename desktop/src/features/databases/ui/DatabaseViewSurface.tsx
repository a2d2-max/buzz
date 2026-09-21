import { AlertTriangle, Plus, RotateCcw } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import type { DatabaseRow } from "../lib/databaseRowCodec";
import type {
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseSchema,
  DatabaseSchemaContent,
} from "../lib/databaseSchemaCodec";
import { changeDatabasePropertyType } from "../lib/databaseSchemaCommands";
import {
  compareRelayVersions,
  type DatabaseCellValue,
} from "../lib/databaseValue";
import {
  resolveDatabaseView,
  type DatabaseValueResolver,
} from "../lib/databaseViewEngine";
import { DatabaseConflictError } from "../lib/useCommunityDatabases";
import { DatabaseBoardSurface } from "./DatabaseBoardSurface";
import { DatabaseCalendarSurface } from "./DatabaseCalendarSurface";
import { DatabaseGallerySurface } from "./DatabaseGallerySurface";
import { DatabaseGroupedTableSurface } from "./DatabaseGroupedTableSurface";
import { DatabaseTableSurface } from "./DatabaseTableSurface";
import {
  DatabaseViewSettings,
  type DatabaseSchemaMutation,
} from "./DatabaseViewSettings";
import { DatabaseViewTabs } from "./DatabaseViewTabs";
import type { DatabaseRelationCellContext } from "./DatabaseRelationCell";

type SchemaFailure = {
  mutation: DatabaseSchemaMutation;
  selectAfter?: string;
  baseEventId: string;
  message: string;
};

function editableSchema(schema: DatabaseSchema): DatabaseSchemaContent {
  return {
    name: schema.name,
    ...(schema.icon ? { icon: schema.icon } : {}),
    properties: schema.properties,
    views: schema.views,
    createdAt: schema.createdAt,
    updatedAt: schema.updatedAt,
  };
}

function compatibleRendererGroup(
  viewType: "table" | "board" | "calendar" | "gallery",
  property: DatabaseProperty | null,
): boolean {
  if (!property) return false;
  if (viewType === "board") {
    return ["select", "status", "person"].includes(property.type);
  }
  if (viewType === "calendar") return property.type === "date";
  return true;
}

/** Route-free controller shared by full-page and future inline database views. */
export function DatabaseViewSurface({
  onAddRow,
  onSaveRowValues,
  onSaveSchema,
  onSelectView,
  resolveValue,
  relationContext,
  rows,
  schema,
  viewId,
}: {
  onAddRow: () => Promise<DatabaseRow>;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  onSaveSchema: (
    content: DatabaseSchemaContent,
    baseEventId: string,
  ) => Promise<DatabaseSchema>;
  onSelectView: (viewId: string) => void;
  resolveValue?: DatabaseValueResolver;
  relationContext?: DatabaseRelationCellContext;
  rows: DatabaseRow[];
  schema: DatabaseSchema;
  viewId?: string;
}) {
  const [currentSchema, setCurrentSchema] = React.useState(schema);
  const [savingSchema, setSavingSchema] = React.useState(false);
  const [failure, setFailure] = React.useState<SchemaFailure | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [addingRow, setAddingRow] = React.useState(false);
  const acceptedSchemaRef = React.useRef(schema);

  React.useEffect(() => {
    if (compareRelayVersions(schema, acceptedSchemaRef.current) < 0) return;
    acceptedSchemaRef.current = schema;
    if (!failure) {
      if (!savingSchema) setCurrentSchema(schema);
      return;
    }
    if (failure.baseEventId === schema.eventId) return;
    try {
      setCurrentSchema(failure.mutation(schema));
      setFailure({
        ...failure,
        baseEventId: schema.eventId,
        message:
          "A newer database schema was loaded. Retry to apply your view change to it.",
      });
    } catch (error) {
      setCurrentSchema(schema);
      setFailure({
        ...failure,
        baseEventId: schema.eventId,
        message:
          error instanceof Error
            ? error.message
            : "Couldn't reapply this view change.",
      });
    }
  }, [failure, savingSchema, schema]);

  const requestedView =
    viewId === undefined
      ? undefined
      : currentSchema.views.find((view) => view.id === viewId);
  const missingRequestedView = viewId !== undefined && !requestedView;
  const selected = missingRequestedView
    ? undefined
    : (requestedView ?? currentSchema.views[0]);

  const saveMutation = React.useCallback(
    async (
      mutation: DatabaseSchemaMutation,
      selectAfter?: string,
      base = acceptedSchemaRef.current,
    ) => {
      if (savingSchema) return;
      let next: DatabaseSchema;
      try {
        next = mutation(base);
      } catch (error) {
        setFailure({
          mutation,
          selectAfter,
          baseEventId: base.eventId,
          message:
            error instanceof Error
              ? error.message
              : "Couldn't apply this view change.",
        });
        return;
      }
      setCurrentSchema(next);
      setFailure(null);
      setSavingSchema(true);
      try {
        const saved = await onSaveSchema(editableSchema(next), base.eventId);
        acceptedSchemaRef.current = saved;
        setCurrentSchema(saved);
        if (selectAfter) onSelectView(selectAfter);
      } catch (error) {
        const newest =
          error instanceof DatabaseConflictError && "properties" in error.newest
            ? error.newest
            : base;
        acceptedSchemaRef.current = newest;
        try {
          setCurrentSchema(mutation(newest));
        } catch {
          setCurrentSchema(newest);
        }
        setFailure({
          mutation,
          selectAfter,
          baseEventId: newest.eventId,
          message:
            newest !== base
              ? "A newer database schema was loaded. Retry to apply your view change to it."
              : error instanceof Error
                ? error.message
                : "Couldn't save this view change.",
        });
      } finally {
        setSavingSchema(false);
      }
    },
    [onSaveSchema, onSelectView, savingSchema],
  );

  if (missingRequestedView) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-start gap-3 p-6"
        data-testid="database-missing-view"
      >
        <div
          className="flex items-center gap-2 text-sm text-amber-700"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          Saved view {viewId} is unavailable. Choose a view to recover this
          block.
        </div>
        <label className="flex flex-col gap-1 text-xs">
          Available database view
          <select
            aria-label="Available database view"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) => {
              if (event.target.value) onSelectView(event.target.value);
            }}
            value=""
          >
            <option value="">Choose a view…</option>
            {currentSchema.views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This database has no views.
      </div>
    );
  }

  const result = resolveDatabaseView({
    schema: currentSchema,
    view: selected,
    rows,
    ...(resolveValue ? { resolveValue } : {}),
  });
  const titleProperty =
    currentSchema.properties.find((property) => property.type === "title") ??
    currentSchema.properties[0];
  const visibleById = new Map(
    currentSchema.properties.map((property) => [property.id, property]),
  );
  const visibleProperties = selected.visiblePropertyIds
    .map((id) => visibleById.get(id))
    .filter((property): property is DatabaseProperty => Boolean(property));
  const locked = savingSchema || failure !== null;
  const usesGroupedTable = Boolean(
    selected.type === "table" &&
      selected.group &&
      result.groupProperty &&
      result.groupError === null,
  );

  const renderer = (() => {
    if (!titleProperty) {
      return (
        <div className="p-6 text-sm text-muted-foreground">
          This database needs a title property.
        </div>
      );
    }
    if (selected.type === "table") {
      return usesGroupedTable ? (
        <DatabaseGroupedTableSurface
          groups={result.groups}
          onRestoreType={(propertyId: string, type: DatabasePropertyType) =>
            saveMutation((latest) =>
              changeDatabasePropertyType(latest, propertyId, type),
            ).then(() => undefined)
          }
          onSaveRowValues={onSaveRowValues}
          properties={visibleProperties}
          propertyWidths={selected.propertyWidths}
          relationContext={relationContext}
        />
      ) : (
        <DatabaseTableSurface
          key={selected.id}
          onAddRow={onAddRow}
          onSaveRowValues={onSaveRowValues}
          onSaveSchema={onSaveSchema}
          rows={result.rows.map(({ row }) => row)}
          relationContext={relationContext}
          resolveValue={resolveValue}
          schema={currentSchema}
          viewId={selected.id}
        />
      );
    }
    if (selected.type === "board") {
      return compatibleRendererGroup(selected.type, result.groupProperty) &&
        result.groupError === null ? (
        <DatabaseBoardSurface
          groups={result.groups}
          groupProperty={result.groupProperty as DatabaseProperty}
          onSaveRowValues={onSaveRowValues}
          titleProperty={titleProperty}
        />
      ) : (
        <MissingGroupState kind="board" />
      );
    }
    if (selected.type === "calendar") {
      return compatibleRendererGroup(selected.type, result.groupProperty) &&
        result.groupError === null ? (
        <DatabaseCalendarSurface
          dateProperty={result.groupProperty as DatabaseProperty}
          onSaveRowValues={onSaveRowValues}
          rows={result.rows}
          titleProperty={titleProperty}
        />
      ) : (
        <MissingGroupState kind="calendar" />
      );
    }
    return (
      <DatabaseGallerySurface
        groups={
          selected.group && result.groupError === null
            ? result.groups
            : undefined
        }
        properties={visibleProperties}
        rows={result.rows}
        titleProperty={titleProperty}
      />
    );
  })();

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="database-view-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        <DatabaseViewTabs
          disabled={locked}
          onChange={(mutation, selectAfter) =>
            void saveMutation(mutation, selectAfter)
          }
          onSelect={onSelectView}
          schema={currentSchema}
          selectedViewId={selected.id}
        />
        <DatabaseViewSettings
          disabled={locked}
          onApply={(mutation) => void saveMutation(mutation)}
          schema={currentSchema}
          view={selected}
        />
        {selected.type !== "table" || usesGroupedTable ? (
          <Button
            disabled={addingRow}
            onClick={() => {
              setAddingRow(true);
              setRowError(null);
              void onAddRow()
                .catch((error) => {
                  setRowError(
                    error instanceof Error
                      ? error.message
                      : "Couldn't add a row.",
                  );
                })
                .finally(() => setAddingRow(false));
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus /> {addingRow ? "Adding…" : "New row"}
          </Button>
        ) : null}
      </div>
      {failure ? (
        <div
          className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          <span>{failure.message}</span>
          <Button
            aria-label="Retry view change"
            onClick={() =>
              void saveMutation(failure.mutation, failure.selectAfter)
            }
            size="xs"
            type="button"
            variant="outline"
          >
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : null}
      {rowError ? (
        <div className="px-4 py-2 text-xs text-destructive" role="alert">
          {rowError}
        </div>
      ) : null}
      {result.diagnostics.length ? (
        <div
          className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-700"
          role="status"
        >
          <AlertTriangle className="h-3.5 w-3.5" /> Some saved filters need
          attention in View settings.
        </div>
      ) : null}
      {result.computedErrors.length ? (
        <div
          className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          data-testid="database-computed-errors"
          role="alert"
        >
          {result.computedErrors.length} computed value
          {result.computedErrors.length === 1 ? "" : "s"} need attention.{" "}
          {result.computedErrors
            .slice(0, 3)
            .map(({ error }) => `${error.code}: ${error.detail}`)
            .join(" · ")}
        </div>
      ) : null}
      {renderer}
    </div>
  );
}

function MissingGroupState({ kind }: { kind: "board" | "calendar" }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <AlertTriangle className="h-6 w-6 text-amber-600" />
      <p className="text-sm font-medium">
        Choose {kind === "calendar" ? "a Date" : "a Select, Status, or Person"}{" "}
        property
      </p>
      <p className="text-xs text-muted-foreground">
        Open View settings to repair this saved {kind} configuration.
      </p>
    </div>
  );
}
