import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  Announcements,
  CollisionDetection,
  DragEndEvent,
  DragStartEvent,
  KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { GripVertical, RotateCcw } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import { buildDatabaseBoardDropValues } from "../lib/databaseBoardModel";
import { databaseCellPresentation } from "../lib/databaseCellModel";
import type { DatabaseRow } from "../lib/databaseRowCodec";
import type { DatabaseProperty } from "../lib/databaseSchemaCodec";
import type { DatabaseCellValue } from "../lib/databaseValue";
import type { DatabaseRowGroup } from "../lib/databaseViewEngine";

type BoardCardData = {
  type: "database-board-card";
  rowId: string;
  source: string | null;
};
type BoardColumnData = {
  type: "database-board-column";
  target: string | null;
  label: string;
};

const COLUMN_STEP = 268;
const CARD_STEP = 48;

const collisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

const keyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates },
) => {
  switch (event.code) {
    case "ArrowRight":
      return { ...currentCoordinates, x: currentCoordinates.x + COLUMN_STEP };
    case "ArrowLeft":
      return { ...currentCoordinates, x: currentCoordinates.x - COLUMN_STEP };
    case "ArrowDown":
      return { ...currentCoordinates, y: currentCoordinates.y + CARD_STEP };
    case "ArrowUp":
      return { ...currentCoordinates, y: currentCoordinates.y - CARD_STEP };
    default:
      return undefined;
  }
};

function BoardCard({
  disabled,
  dragging,
  failure,
  onRetry,
  row,
  source,
  title,
}: {
  disabled: boolean;
  dragging: boolean;
  failure?: string;
  onRetry: () => void;
  row: DatabaseRow;
  source: string | null;
  title: string;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef } =
    useDraggable({
      disabled,
      id: `${source ?? "empty"}:${row.id}`,
      data: {
        type: "database-board-card",
        rowId: row.id,
        source,
      } satisfies BoardCardData,
    });
  const dragAttributes = { ...attributes, role: undefined };
  return (
    <article
      className="flex items-start gap-2 rounded-lg border border-border/60 bg-background p-2 shadow-xs"
      data-drag-state={dragging ? "dragging" : undefined}
      data-row-id={row.id}
      data-testid="database-board-card"
      ref={setNodeRef}
    >
      <button
        aria-label={`Move ${title}`}
        className="mt-0.5 shrink-0 cursor-grab touch-none rounded text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        disabled={disabled}
        ref={setActivatorNodeRef}
        type="button"
        {...dragAttributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{title}</p>
        {failure ? (
          <div
            className="mt-1 flex items-center gap-1 text-2xs text-destructive"
            role="alert"
          >
            <span>{failure}</span>
            <Button
              aria-label={`Retry moving ${title}`}
              onClick={onRetry}
              size="xs"
              type="button"
              variant="outline"
            >
              <RotateCcw /> Retry
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function BoardColumn({
  children,
  group,
  propertyName,
}: {
  children: React.ReactNode;
  group: DatabaseRowGroup;
  propertyName: string;
}) {
  const target = typeof group.value === "string" ? group.value : null;
  const { isOver, setNodeRef } = useDroppable({
    id: group.key,
    data: {
      type: "database-board-column",
      target,
      label: group.label,
    } satisfies BoardColumnData,
  });
  return (
    <section
      aria-label={`${group.label} ${propertyName}`}
      className="flex w-64 shrink-0 flex-col gap-2"
      data-group-key={group.key}
      data-testid="database-board-column"
    >
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium">
        <span>{group.label}</span>
        <span className="text-muted-foreground">{group.rows.length}</span>
      </h3>
      <div
        className={`flex min-h-32 flex-1 flex-col gap-2 rounded-lg p-2 ${isOver ? "bg-muted ring-2 ring-primary/30" : "bg-muted/30"}`}
        ref={setNodeRef}
      >
        {children}
      </div>
    </section>
  );
}

type MoveFailure = {
  row: DatabaseRow;
  source: string | null;
  target: string | null;
  values: Record<string, DatabaseCellValue>;
  baseEventId: string;
  message: string;
};

/** Drag-and-drop renderer for select, status, and person database groups. */
export function DatabaseBoardSurface({
  groups,
  groupProperty,
  titleProperty,
  onSaveRowValues,
}: {
  groups: DatabaseRowGroup[];
  groupProperty: DatabaseProperty;
  titleProperty: DatabaseProperty;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
}) {
  const [activeRowId, setActiveRowId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState<Set<string>>(() => new Set());
  const [failures, setFailures] = React.useState<Map<string, MoveFailure>>(
    () => new Map(),
  );
  const rows = React.useMemo(
    () =>
      new Map(
        groups.flatMap((group) => group.rows.map(({ row }) => [row.id, row])),
      ),
    [groups],
  );
  const titleOf = React.useCallback(
    (row: DatabaseRow) =>
      databaseCellPresentation(titleProperty, row).text.trim() || "Untitled",
    [titleProperty],
  );

  React.useEffect(() => {
    setFailures((current) => {
      let next = current;
      for (const [rowId, failure] of current) {
        const newest = rows.get(rowId);
        if (!newest || newest.eventId === failure.baseEventId) continue;
        const values = buildDatabaseBoardDropValues({
          row: newest,
          property: groupProperty,
          source: failure.source,
          target: failure.target,
        });
        if (!values) continue;
        if (next === current) next = new Map(current);
        next.set(rowId, {
          ...failure,
          row: newest,
          values,
          baseEventId: newest.eventId,
          message: "A newer row was loaded. Retry to apply this move to it.",
        });
      }
      return next;
    });
  }, [groupProperty, rows]);

  const persist = React.useCallback(
    async (failure: MoveFailure) => {
      setSaving((current) => new Set(current).add(failure.row.id));
      setFailures((current) => {
        const next = new Map(current);
        next.delete(failure.row.id);
        return next;
      });
      try {
        await onSaveRowValues(
          failure.row.id,
          failure.values,
          failure.baseEventId,
        );
      } catch (error) {
        setFailures((current) =>
          new Map(current).set(failure.row.id, {
            ...failure,
            message:
              error instanceof Error
                ? error.message
                : "Couldn't move this row.",
          }),
        );
      } finally {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(failure.row.id);
          return next;
        });
      }
    },
    [onSaveRowValues],
  );

  const move = React.useCallback(
    (row: DatabaseRow, source: string | null, target: string | null) => {
      const values = buildDatabaseBoardDropValues({
        row,
        property: groupProperty,
        source,
        target,
      });
      if (!values) return;
      void persist({
        row,
        source,
        target,
        values,
        baseEventId: row.eventId,
        message: "",
      });
    },
    [groupProperty, persist],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  const announcements = React.useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => {
        const card = active.data.current as BoardCardData | undefined;
        const row =
          card?.type === "database-board-card"
            ? rows.get(card.rowId)
            : undefined;
        return `Picked up ${row ? titleOf(row) : "row"}.`;
      },
      onDragOver: ({ active, over }) => {
        const card = active.data.current as BoardCardData | undefined;
        const row =
          card?.type === "database-board-card"
            ? rows.get(card.rowId)
            : undefined;
        const data = over?.data.current as BoardColumnData | undefined;
        return data?.type === "database-board-column"
          ? `${row ? titleOf(row) : "Row"} is over ${data.label}.`
          : `${row ? titleOf(row) : "Row"} is not over a group.`;
      },
      onDragEnd: ({ active, over }) => {
        const card = active.data.current as BoardCardData | undefined;
        const row =
          card?.type === "database-board-card"
            ? rows.get(card.rowId)
            : undefined;
        const column = over?.data.current as BoardColumnData | undefined;
        const values =
          row &&
          card?.type === "database-board-card" &&
          column?.type === "database-board-column"
            ? buildDatabaseBoardDropValues({
                row,
                property: groupProperty,
                source: card.source,
                target: column.target,
              })
            : null;
        return values && column?.type === "database-board-column"
          ? `Moved ${row ? titleOf(row) : "row"} to ${column.label}.`
          : `${row ? titleOf(row) : "Row"} was left where it was.`;
      },
      onDragCancel: ({ active }) => {
        const card = active.data.current as BoardCardData | undefined;
        const row =
          card?.type === "database-board-card"
            ? rows.get(card.rowId)
            : undefined;
        return `Cancelled. ${row ? titleOf(row) : "Row"} was left where it was.`;
      },
    }),
    [groupProperty, rows, titleOf],
  );
  const activeRow = activeRowId ? rows.get(activeRowId) : undefined;

  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as BoardCardData | undefined;
    if (data?.type === "database-board-card") setActiveRowId(data.rowId);
  };
  const onDragEnd = (event: DragEndEvent) => {
    setActiveRowId(null);
    const card = event.active.data.current as BoardCardData | undefined;
    const column = event.over?.data.current as BoardColumnData | undefined;
    if (
      card?.type !== "database-board-card" ||
      column?.type !== "database-board-column"
    ) {
      return;
    }
    const row = rows.get(card.rowId);
    if (row && !saving.has(row.id)) move(row, card.source, column.target);
  };

  return (
    <DndContext
      accessibility={{ announcements }}
      collisionDetection={collisionDetection}
      onDragCancel={() => setActiveRowId(null)}
      onDragEnd={onDragEnd}
      onDragStart={onDragStart}
      sensors={sensors}
    >
      <div
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4"
        data-testid="database-board-surface"
      >
        {groups.map((group) => (
          <BoardColumn
            group={group}
            key={group.key}
            propertyName={groupProperty.name}
          >
            {group.rows.map(({ row }) => {
              const failure = failures.get(row.id);
              const source =
                typeof group.value === "string" ? group.value : null;
              return (
                <BoardCard
                  disabled={saving.has(row.id)}
                  dragging={row.id === activeRowId}
                  failure={failure?.message}
                  key={`${group.key}:${row.id}`}
                  onRetry={() => {
                    if (failure) void persist(failure);
                  }}
                  row={row}
                  source={source}
                  title={titleOf(row)}
                />
              );
            })}
          </BoardColumn>
        ))}
      </div>
      <DragOverlay>
        {activeRow ? (
          <div
            className="pointer-events-none w-64 rounded-lg border border-border bg-background p-2 text-xs shadow-lg"
            data-testid="database-board-overlay"
          >
            {titleOf(activeRow)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
