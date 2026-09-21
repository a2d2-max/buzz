// biome-ignore-all lint/a11y/useSemanticElements: react-window requires a div-based virtual ARIA grid.
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import * as React from "react";
import { List, type RowComponentProps } from "react-window";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import type { DatabaseRow } from "../lib/databaseRowCodec";
import type {
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseSchema,
  DatabaseSchemaContent,
} from "../lib/databaseSchemaCodec";
import { DATABASE_PROPERTY_TYPES } from "../lib/databaseSchemaCodec";
import {
  addDatabaseProperty,
  changeDatabasePropertyType,
  defaultDatabaseProperty,
  moveDatabaseProperty,
  setDatabasePropertyVisible,
  setDatabasePropertyWidth,
} from "../lib/databaseSchemaCommands";
import { updateDatabaseStatusChoices } from "../lib/databaseViewCommands";
import {
  compareRelayVersions,
  type DatabaseCellValue,
} from "../lib/databaseValue";
import {
  databasePropertyLabel,
  databasePropertyRegistration,
} from "../lib/databasePropertyRegistry";
import type { DatabaseValueResolver } from "../lib/databaseViewEngine";
import { DatabaseConflictError } from "../lib/useCommunityDatabases";
import { DatabaseCell } from "./DatabaseCell";
import type { DatabaseRelationCellContext } from "./DatabaseRelationCell";

type DatabaseTableSurfaceProps = {
  schema: DatabaseSchema;
  rows: DatabaseRow[];
  viewId: string;
  onAddRow: () => Promise<DatabaseRow>;
  onSaveSchema: (
    content: DatabaseSchemaContent,
    baseEventId: string,
  ) => Promise<DatabaseSchema>;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  relationContext?: DatabaseRelationCellContext;
  resolveValue?: DatabaseValueResolver;
};

type SchemaFailure = {
  mutation: SchemaMutation;
  content: DatabaseSchemaContent;
  baseEventId: string;
  message: string;
};

type SchemaMutation = (schema: DatabaseSchema) => DatabaseSchema;

const TABLE_FEATURES = tableFeatures({});
const columnHelper = createColumnHelper<typeof TABLE_FEATURES, DatabaseRow>();
const PRIMARY_PROPERTY_TYPES: readonly DatabasePropertyType[] =
  DATABASE_PROPERTY_TYPES.filter(
    (type) =>
      databasePropertyRegistration(type).availableInTable &&
      !["relation", "formula", "rollup"].includes(type),
  );

function schemaContent(schema: DatabaseSchema): DatabaseSchemaContent {
  return {
    name: schema.name,
    ...(schema.icon ? { icon: schema.icon } : {}),
    properties: schema.properties,
    views: schema.views,
    createdAt: schema.createdAt,
    updatedAt: schema.updatedAt,
  };
}

function newPropertyId(): string {
  return `property_${crypto.randomUUID().replaceAll("-", "")}`;
}

function updateDatabaseChoices(
  schema: DatabaseSchema,
  propertyId: string,
  draft: string,
): DatabaseSchema {
  const property = schema.properties.find(
    (
      candidate,
    ): candidate is Extract<
      DatabaseProperty,
      { type: "select" | "multi_select" }
    > =>
      candidate.id === propertyId &&
      (candidate.type === "select" || candidate.type === "multi_select"),
  );
  if (!property) throw new Error("This choice property no longer exists.");
  const names = [
    ...new Set(
      draft
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  const existing = new Map(
    property.options.choices.map((choice) => [
      choice.name.toLocaleLowerCase(),
      choice,
    ]),
  );
  const choices = names.map((name) => {
    const current = existing.get(name.toLocaleLowerCase());
    return (
      current ?? {
        id: `choice_${crypto.randomUUID().replaceAll("-", "")}`,
        name,
      }
    );
  });
  return {
    ...schema,
    properties: schema.properties.map((candidate) =>
      candidate.id === property.id
        ? { ...property, options: { choices } }
        : candidate,
    ),
  };
}

function updateDatabaseNumberFormat(
  schema: DatabaseSchema,
  propertyId: string,
  format: "integer" | "decimal" | "percent" | "won",
): DatabaseSchema {
  let found = false;
  const properties = schema.properties.map((property) => {
    if (property.id !== propertyId) return property;
    if (property.type !== "number") {
      throw new Error("This number property changed type.");
    }
    found = true;
    return { ...property, options: { format } };
  });
  if (!found) throw new Error("This number property no longer exists.");
  return { ...schema, properties };
}

function statusChoiceIntent(
  property: Extract<DatabaseProperty, { type: "status" }>,
  draft: string,
) {
  const existing = new Map(
    property.options.choices.map((choice) => [
      choice.name.toLocaleLowerCase(),
      choice,
    ]),
  );
  return draft
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      const name = (separator < 0 ? entry : entry.slice(0, separator)).trim();
      const group = (
        separator < 0 ? "todo" : entry.slice(separator + 1).trim()
      ) as "todo" | "doing" | "done";
      if (!name || !["todo", "doing", "done"].includes(group)) {
        throw new Error("Use Status name:todo, name:doing, or name:done.");
      }
      const current = existing.get(name.toLocaleLowerCase());
      return {
        id: current?.id ?? `choice_${crypto.randomUUID().replaceAll("-", "")}`,
        name,
        group,
        ...(current?.color ? { color: current.color } : {}),
      };
    });
}

type VirtualRowData = {
  rows: ReturnType<
    ReturnType<
      typeof useTable<typeof TABLE_FEATURES, DatabaseRow>
    >["getRowModel"]
  >["rows"];
  properties: DatabaseProperty[];
  widths: Record<string, number>;
  totalWidth: number;
  onRestoreType: (
    propertyId: string,
    type: DatabasePropertyType,
  ) => Promise<void>;
  onSaveRowValues: DatabaseTableSurfaceProps["onSaveRowValues"];
  knownPubkeys: string[];
  relationContext?: DatabaseRelationCellContext;
  resolveValue?: DatabaseValueResolver;
};

function VirtualDatabaseRow({
  ariaAttributes,
  index,
  style,
  rows,
  properties,
  widths,
  totalWidth,
  onRestoreType,
  onSaveRowValues,
  knownPubkeys,
  relationContext,
  resolveValue,
}: RowComponentProps<VirtualRowData>) {
  const tableRow = rows[index];
  if (!tableRow) return null;
  const row = tableRow.original;
  return (
    <div
      {...ariaAttributes}
      className="flex border-b border-border/50 bg-background hover:bg-muted/20"
      data-testid={`database-row-${row.id}`}
      role="row"
      style={{ ...style, minWidth: totalWidth, width: totalWidth }}
      tabIndex={-1}
    >
      {properties.map((property) => (
        <DatabaseCell
          key={property.id}
          knownPubkeys={knownPubkeys}
          onRestoreType={(type) => onRestoreType(property.id, type)}
          onSave={(values, baseEventId) =>
            onSaveRowValues(row.id, values, baseEventId)
          }
          property={property}
          relationContext={relationContext}
          resolvedValue={resolveValue?.(row, property)}
          row={row}
          width={widths[property.id] ?? 180}
        />
      ))}
    </div>
  );
}

export function DatabaseTableSurface({
  schema,
  rows,
  viewId,
  onAddRow,
  onSaveSchema,
  onSaveRowValues,
  relationContext,
  resolveValue,
}: DatabaseTableSurfaceProps) {
  const [currentSchema, setCurrentSchema] = React.useState(schema);
  const [schemaFailure, setSchemaFailure] =
    React.useState<SchemaFailure | null>(null);
  const [schemaActionError, setSchemaActionError] = React.useState<
    string | null
  >(null);
  const [schemaSaving, setSchemaSaving] = React.useState(false);
  const [viewport, setViewport] = React.useState({ height: 520, width: 800 });
  const [addingRow, setAddingRow] = React.useState(false);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [newPropertyName, setNewPropertyName] = React.useState("");
  const [newPropertyType, setNewPropertyType] =
    React.useState<DatabasePropertyType>("text");
  const [showAddProperty, setShowAddProperty] = React.useState(false);
  const acceptedSchemaRef = React.useRef(schema);
  const viewportRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (compareRelayVersions(schema, acceptedSchemaRef.current) < 0) return;
    acceptedSchemaRef.current = schema;
    if (!schemaFailure) {
      if (!schemaSaving) setCurrentSchema(schema);
      return;
    }
    if (schemaFailure.baseEventId === schema.eventId) return;
    try {
      const content = schemaContent(schemaFailure.mutation(schema));
      setCurrentSchema({ ...schema, ...content });
      setSchemaFailure({
        ...schemaFailure,
        content,
        baseEventId: schema.eventId,
        message:
          "A newer database schema was loaded. Retry to apply your change to it.",
      });
    } catch (error) {
      setCurrentSchema(schema);
      setSchemaActionError(
        error instanceof Error
          ? error.message
          : "Couldn't reapply this database change.",
      );
    }
  }, [schema, schemaFailure, schemaSaving]);
  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setViewport({
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const view =
    currentSchema.views.find((candidate) => candidate.id === viewId) ??
    currentSchema.views[0];
  const schemaLocked = schemaSaving || schemaFailure !== null;
  const visibleProperties = React.useMemo(() => {
    if (!view) return [];
    const byId = new Map(
      currentSchema.properties.map((property) => [property.id, property]),
    );
    return view.visiblePropertyIds
      .map((id) => byId.get(id))
      .filter((property): property is DatabaseProperty => Boolean(property));
  }, [currentSchema.properties, view]);
  const hiddenProperties = React.useMemo(() => {
    const visible = new Set(visibleProperties.map((property) => property.id));
    return currentSchema.properties.filter(
      (property) => !visible.has(property.id),
    );
  }, [currentSchema.properties, visibleProperties]);
  const widths = view?.propertyWidths ?? {};
  const totalWidth = visibleProperties.reduce(
    (total, property) => total + (widths[property.id] ?? 180),
    0,
  );
  const knownPubkeys = React.useMemo(
    () => [
      ...new Set(
        rows
          .flatMap((row) => [row.createdBy, row.author])
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    [rows],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns(
        visibleProperties.map((property) =>
          columnHelper.display({ id: property.id, header: property.name }),
        ),
      ),
    [visibleProperties],
  );
  const table = useTable({ features: TABLE_FEATURES, columns, data: rows });
  const tableRows = table.getRowModel().rows;

  const saveSchemaMutation = React.useCallback(
    async (mutation: SchemaMutation, base = acceptedSchemaRef.current) => {
      let next: DatabaseSchema;
      try {
        next = mutation(base);
      } catch (error) {
        setSchemaActionError(
          error instanceof Error
            ? error.message
            : "Couldn't apply this database change.",
        );
        return;
      }
      const content = schemaContent(next);
      const baseEventId = base.eventId;
      setCurrentSchema(next);
      setSchemaFailure(null);
      setSchemaActionError(null);
      setSchemaSaving(true);
      try {
        const saved = await onSaveSchema(content, baseEventId);
        acceptedSchemaRef.current = saved;
        setCurrentSchema(saved);
      } catch (error) {
        const newest =
          error instanceof DatabaseConflictError && "properties" in error.newest
            ? error.newest
            : base;
        acceptedSchemaRef.current = newest;
        let rebased: DatabaseSchema;
        try {
          rebased = mutation(newest);
        } catch (rebaseError) {
          setCurrentSchema(newest);
          setSchemaFailure({
            mutation,
            content,
            baseEventId: newest.eventId,
            message:
              rebaseError instanceof Error
                ? rebaseError.message
                : "Couldn't reapply this database change.",
          });
          return;
        }
        const rebasedContent = schemaContent(rebased);
        setCurrentSchema(rebased);
        setSchemaFailure({
          mutation,
          content: rebasedContent,
          baseEventId: newest.eventId,
          message:
            newest !== base
              ? "A newer database schema was loaded. Retry to apply your change to it."
              : error instanceof Error
                ? error.message
                : "Couldn't save database settings.",
        });
      } finally {
        setSchemaSaving(false);
      }
    },
    [onSaveSchema],
  );

  const retrySchema = () => {
    if (!schemaFailure) return;
    void saveSchemaMutation(schemaFailure.mutation);
  };

  const restoreType = React.useCallback(
    async (propertyId: string, type: DatabasePropertyType) => {
      try {
        await saveSchemaMutation((latest) =>
          changeDatabasePropertyType(latest, propertyId, type),
        );
      } catch (error) {
        setSchemaActionError(
          error instanceof Error
            ? error.message
            : "Couldn't change this property.",
        );
      }
    },
    [saveSchemaMutation],
  );
  const applySchemaChange = React.useCallback(
    (mutation: SchemaMutation) => {
      if (schemaSaving || schemaFailure) return;
      try {
        setSchemaActionError(null);
        void saveSchemaMutation(mutation);
      } catch (error) {
        setSchemaActionError(
          error instanceof Error
            ? error.message
            : "Couldn't change this database.",
        );
      }
    },
    [saveSchemaMutation, schemaFailure, schemaSaving],
  );
  const changePropertyType = React.useCallback(
    (property: DatabaseProperty, type: DatabasePropertyType) => {
      if (property.type === type) return;
      applySchemaChange((latest) =>
        changeDatabasePropertyType(latest, property.id, type),
      );
    },
    [applySchemaChange],
  );
  const rowKey = React.useCallback(
    (index: number, data: VirtualRowData) =>
      data.rows[index]?.original.id ?? index,
    [],
  );

  const addProperty = () => {
    const name = newPropertyName.trim();
    if (!name) return;
    const property = defaultDatabaseProperty(
      newPropertyId(),
      name,
      newPropertyType,
    );
    applySchemaChange((latest) => addDatabaseProperty(latest, property));
    setNewPropertyName("");
    setShowAddProperty(false);
  };

  if (!view) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This database has no table view.
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="database-table-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2">
        <Button
          disabled={schemaLocked}
          onClick={() => setShowAddProperty((value) => !value)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus /> Property
        </Button>
        {hiddenProperties.length ? (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Eye className="h-3.5 w-3.5" />
            {hiddenProperties.map((property) => (
              <Button
                key={property.id}
                disabled={schemaLocked}
                onClick={() =>
                  applySchemaChange((latest) =>
                    setDatabasePropertyVisible(
                      latest,
                      view.id,
                      property.id,
                      true,
                    ),
                  )
                }
                size="xs"
                type="button"
                variant="ghost"
              >
                Show {property.name}
              </Button>
            ))}
          </div>
        ) : null}
        {schemaFailure ? (
          <div
            className="ml-auto flex items-center gap-2 text-xs text-destructive"
            role="alert"
          >
            <span>{schemaFailure.message}</span>
            <Button
              aria-label="Retry database settings"
              onClick={() => void retrySchema()}
              size="xs"
              type="button"
              variant="outline"
            >
              <RotateCcw /> Retry
            </Button>
          </div>
        ) : null}
        {schemaActionError ? (
          <span className="ml-auto text-xs text-destructive" role="alert">
            {schemaActionError}
          </span>
        ) : null}
      </div>
      {showAddProperty ? (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-4 py-2">
          <Input
            aria-label="Property name"
            className="h-8 max-w-64 text-xs"
            onChange={(event) => setNewPropertyName(event.target.value)}
            placeholder="Property name"
            value={newPropertyName}
          />
          <select
            aria-label="Property type"
            className="h-8 rounded-md border border-input/40 bg-background px-2 text-xs"
            onChange={(event) =>
              setNewPropertyType(event.target.value as DatabasePropertyType)
            }
            value={newPropertyType}
          >
            {PRIMARY_PROPERTY_TYPES.filter((type) => type !== "title").map(
              (type) => (
                <option key={type} value={type}>
                  {databasePropertyLabel(type)}
                </option>
              ),
            )}
          </select>
          <Button
            disabled={schemaLocked || !newPropertyName.trim()}
            onClick={addProperty}
            size="sm"
            type="button"
          >
            Add
          </Button>
        </div>
      ) : null}
      <div
        aria-label={currentSchema.name}
        className="min-h-0 flex-1 overflow-auto"
        onKeyDown={(event) => {
          if (!event.key.startsWith("Arrow")) return;
          const target = event.target;
          if (
            !(target instanceof HTMLElement) ||
            target.dataset.databaseCellTrigger !== "true"
          )
            return;
          const triggers = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "[data-database-cell-trigger='true']",
            ),
          ];
          const current = triggers.indexOf(target);
          const offset =
            event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowRight"
                ? 1
                : event.key === "ArrowUp"
                  ? -visibleProperties.length
                  : visibleProperties.length;
          const next = triggers[current + offset];
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }}
        ref={viewportRef}
        role="grid"
        tabIndex={-1}
      >
        <div
          className="sticky top-0 z-10 flex border-b border-border bg-muted/80 backdrop-blur"
          role="row"
          style={{ minWidth: totalWidth, width: totalWidth }}
          tabIndex={-1}
        >
          {visibleProperties.map((property, index) => (
            <div
              className="flex h-12 items-center gap-2 border-r border-border/60 px-2"
              key={property.id}
              role="columnheader"
              style={{
                minWidth: widths[property.id] ?? 180,
                width: widths[property.id] ?? 180,
              }}
              tabIndex={-1}
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-xs font-medium"
                  title={property.name}
                >
                  {property.name}
                </div>
                <div className="text-2xs text-muted-foreground">
                  {databasePropertyLabel(property.type)}
                </div>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={`Column settings for ${property.name}`}
                    disabled={schemaLocked}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <SlidersHorizontal />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="flex w-64 flex-col gap-3 p-3"
                >
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">Property type</span>
                    <select
                      aria-label={`Type for ${property.name}`}
                      className="h-8 rounded-md border border-input/40 bg-background px-2 text-xs"
                      disabled={schemaLocked}
                      onChange={(event) =>
                        changePropertyType(
                          property,
                          event.target.value as DatabasePropertyType,
                        )
                      }
                      value={property.type}
                    >
                      {PRIMARY_PROPERTY_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {databasePropertyLabel(type)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {property.priorDefinitions?.length ? (
                    <div className="flex flex-wrap gap-1">
                      {property.priorDefinitions.map((definition) => (
                        <Button
                          aria-label={`Restore ${property.name} as ${databasePropertyLabel(definition.type).toLowerCase()}`}
                          disabled={schemaLocked}
                          key={definition.type}
                          onClick={() =>
                            changePropertyType(property, definition.type)
                          }
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          Restore {databasePropertyLabel(definition.type)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {property.type === "number" ? (
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">Number format</span>
                      <select
                        aria-label={`Number format for ${property.name}`}
                        className="h-8 rounded-md border border-input/40 bg-background px-2 text-xs"
                        disabled={schemaLocked}
                        onChange={(event) => {
                          const format = event.target.value as
                            | "integer"
                            | "decimal"
                            | "percent"
                            | "won";
                          applySchemaChange((latest) =>
                            updateDatabaseNumberFormat(
                              latest,
                              property.id,
                              format,
                            ),
                          );
                        }}
                        value={property.options.format}
                      >
                        <option value="integer">Integer</option>
                        <option value="decimal">Decimal</option>
                        <option value="percent">Percent</option>
                        <option value="won">Korean won</option>
                      </select>
                    </label>
                  ) : null}
                  {property.type === "select" ||
                  property.type === "multi_select" ? (
                    <label
                      className="flex flex-col gap-1 text-xs"
                      htmlFor={`database-choices-${property.id}`}
                    >
                      <span className="font-medium">Choices</span>
                      <Input
                        aria-label={`Choices for ${property.name}`}
                        className="h-8 text-xs"
                        defaultValue={property.options.choices
                          .map((choice) => choice.name)
                          .join(", ")}
                        disabled={schemaLocked}
                        id={`database-choices-${property.id}`}
                        key={`${property.id}:${property.options.choices.map((choice) => choice.id).join(":")}`}
                        onBlur={(event) => {
                          const next = event.target.value;
                          const current = property.options.choices
                            .map((choice) => choice.name)
                            .join(", ");
                          if (next !== current)
                            applySchemaChange((latest) =>
                              updateDatabaseChoices(latest, property.id, next),
                            );
                        }}
                        placeholder="Ready, Blocked"
                      />
                    </label>
                  ) : null}
                  {property.type === "status" ? (
                    <label
                      className="flex flex-col gap-1 text-xs"
                      htmlFor={`database-status-choices-${property.id}`}
                    >
                      <span className="font-medium">Status choices</span>
                      <Input
                        aria-label={`Status choices for ${property.name}`}
                        className="h-8 text-xs"
                        defaultValue={property.options.choices
                          .map((choice) => `${choice.name}:${choice.group}`)
                          .join(", ")}
                        disabled={schemaLocked}
                        id={`database-status-choices-${property.id}`}
                        key={`${property.id}:${property.options.choices.map((choice) => `${choice.id}:${choice.group}`).join(":")}`}
                        onBlur={(event) => {
                          const current = property.options.choices
                            .map((choice) => `${choice.name}:${choice.group}`)
                            .join(", ");
                          if (event.target.value === current) return;
                          try {
                            const choices = statusChoiceIntent(
                              property,
                              event.target.value,
                            );
                            applySchemaChange((latest) =>
                              updateDatabaseStatusChoices(
                                latest,
                                property.id,
                                choices,
                              ),
                            );
                          } catch (error) {
                            setSchemaActionError(
                              error instanceof Error
                                ? error.message
                                : "Couldn't change status choices.",
                            );
                          }
                        }}
                        placeholder="To do:todo, Doing:doing, Done:done"
                      />
                    </label>
                  ) : null}
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="flex justify-between font-medium">
                      <span>Column width</span>
                      <span>{widths[property.id] ?? 180}</span>
                    </span>
                    <input
                      aria-label={`Width for ${property.name}`}
                      className="h-6 w-full accent-primary"
                      disabled={schemaLocked}
                      max={720}
                      min={96}
                      onChange={(event) =>
                        setCurrentSchema(
                          setDatabasePropertyWidth(
                            currentSchema,
                            view.id,
                            property.id,
                            Number(event.target.value),
                          ),
                        )
                      }
                      onKeyUp={(event) =>
                        applySchemaChange((latest) =>
                          setDatabasePropertyWidth(
                            latest,
                            view.id,
                            property.id,
                            Number(event.currentTarget.value),
                          ),
                        )
                      }
                      onPointerUp={(event) =>
                        applySchemaChange((latest) =>
                          setDatabasePropertyWidth(
                            latest,
                            view.id,
                            property.id,
                            Number(event.currentTarget.value),
                          ),
                        )
                      }
                      type="range"
                      value={widths[property.id] ?? 180}
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    <Button
                      aria-label={`Move ${property.name} left`}
                      disabled={schemaLocked || index === 0}
                      onClick={() =>
                        applySchemaChange((latest) =>
                          moveDatabaseProperty(
                            latest,
                            view.id,
                            property.id,
                            -1,
                          ),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <ArrowLeft /> Left
                    </Button>
                    <Button
                      aria-label={`Move ${property.name} right`}
                      disabled={
                        schemaLocked || index === visibleProperties.length - 1
                      }
                      onClick={() =>
                        applySchemaChange((latest) =>
                          moveDatabaseProperty(latest, view.id, property.id, 1),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Right <ArrowRight />
                    </Button>
                    <Button
                      aria-label={`Hide ${property.name}`}
                      disabled={schemaLocked || property.type === "title"}
                      onClick={() =>
                        applySchemaChange((latest) =>
                          setDatabasePropertyVisible(
                            latest,
                            view.id,
                            property.id,
                            false,
                          ),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <EyeOff /> Hide
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          ))}
        </div>
        {tableRows.length ? (
          <List
            aria-label={`${currentSchema.name} rows`}
            defaultHeight={440}
            overscanCount={8}
            role="rowgroup"
            rowComponent={VirtualDatabaseRow}
            rowCount={tableRows.length}
            rowHeight={48}
            rowKey={rowKey}
            rowProps={{
              rows: tableRows,
              properties: visibleProperties,
              widths,
              totalWidth,
              onRestoreType: restoreType,
              onSaveRowValues,
              relationContext,
              resolveValue,
              knownPubkeys,
            }}
            style={{
              height: Math.max(144, viewport.height - 48),
              width: Math.max(totalWidth, viewport.width),
            }}
          />
        ) : (
          <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
            No rows yet.
          </div>
        )}
      </div>
      <div className="border-t border-border/60 px-4 py-2">
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
        {rowError ? (
          <span className="ml-2 text-xs text-destructive" role="alert">
            {rowError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
