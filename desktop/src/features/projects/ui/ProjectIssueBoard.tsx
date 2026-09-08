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
import { GripVertical } from "lucide-react";
import * as React from "react";

import type {
  ProjectIssue,
  Repository as Project,
} from "@/features/projects/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import {
  isIssueBoardDropStatus,
  ISSUE_BOARD_COLUMN_ORDER,
  type IssueBoardDropStatus,
  resolveIssueBoardDrop,
} from "@/features/projects/lib/issueBoardColumns";
import { issueStatusVisual } from "@/features/projects/lib/issueStatusDisplay";
import type { ProjectIssueStatus } from "@/features/projects/projectIssues.mjs";
import { cn } from "@/shared/lib/cn";
import { IssueAssigneeFacepile } from "./IssueAssigneesRow";
import { ProjectStatusProgressIcon } from "./ProjectStatusProgressIcon";

export type ProjectIssueBoardItem = {
  issue: ProjectIssue;
  project: Project;
  /**
   * Shown as a chip on the card. Set by the community board, where cards from
   * many repositories share one column; left unset by the per-project board,
   * which already names the project in its own chrome.
   */
  projectName?: string;
};

type IssueCardDragData = { type: "issue-card"; issueId: string };
type IssueColumnDropData = { type: "issue-column"; status: ProjectIssueStatus };

const COLUMN_ID_PREFIX = "issue-column:";
/** `w-64` column plus the `gap-3` between them, so one arrow press = one column. */
const COLUMN_STEP_PX = 268;
const CARD_STEP_PX = 48;

// The stock keyboard getter nudges 25px per press, which needs ten presses to
// cross a column. Step by the real layout instead so the keyboard path lands
// where the pointer path does.
// `pointerWithin` needs pointer coordinates, and a KeyboardEvent has none — on
// the keyboard path it always returns nothing, so a keyboard drop would never
// find a column. Fall back to rectangle overlap there. Overlap, not nearest
// neighbour: hovering a label-only column must resolve to no column at all,
// exactly as the pointer path already does.
const boardCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates },
) => {
  switch (event.code) {
    case "ArrowRight":
      return {
        ...currentCoordinates,
        x: currentCoordinates.x + COLUMN_STEP_PX,
      };
    case "ArrowLeft":
      return {
        ...currentCoordinates,
        x: currentCoordinates.x - COLUMN_STEP_PX,
      };
    case "ArrowDown":
      return { ...currentCoordinates, y: currentCoordinates.y + CARD_STEP_PX };
    case "ArrowUp":
      return { ...currentCoordinates, y: currentCoordinates.y - CARD_STEP_PX };
    default:
      return undefined;
  }
};

function IssueCard({
  draggable,
  isDragging,
  issue,
  onOpen,
  profiles,
  projectName,
}: {
  draggable: boolean;
  isDragging?: boolean;
  issue: ProjectIssue;
  onOpen: () => void;
  profiles?: UserProfileLookup;
  projectName?: string;
}) {
  const visual = issueStatusVisual(issue.status);
  const { attributes, listeners, setActivatorNodeRef, setNodeRef } =
    useDraggable({
      disabled: !draggable,
      id: issue.id,
      data: {
        type: "issue-card",
        issueId: issue.id,
      } satisfies IssueCardDragData,
    });

  // A native <button> already reports role="button"; dnd-kit's own copy would
  // be a second, redundant one on the same element.
  const dragHandleAttributes = { ...attributes, role: undefined };

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-border/60 bg-background/70 px-2 py-2 transition-[opacity,box-shadow] duration-100 ease-out motion-reduce:transition-none",
        isDragging && "opacity-30",
      )}
      data-testid="project-issue-board-card"
      data-drag-state={isDragging ? "dragging" : undefined}
      data-issue-id={issue.id}
      ref={setNodeRef}
    >
      {draggable ? (
        <button
          aria-label={`Move ${issue.title}`}
          className="mt-0.5 shrink-0 cursor-grab touch-none rounded text-muted-foreground/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="project-issue-board-drag-handle"
          ref={setActivatorNodeRef}
          type="button"
          {...dragHandleAttributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
      <button
        className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="project-issue-board-card-open"
        onClick={onOpen}
        type="button"
      >
        <span className="flex min-w-0 items-start gap-1.5">
          <ProjectStatusProgressIcon
            aria-label={issue.status}
            className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", visual.className)}
            state={visual.progress}
          />
          <span className="line-clamp-2 min-w-0 text-xs text-foreground">
            {issue.title}
          </span>
        </span>
        {projectName ? (
          <span
            className="max-w-full truncate rounded-full bg-muted/60 px-1.5 py-0.5 text-2xs text-muted-foreground"
            data-testid="project-issue-board-card-project"
          >
            {projectName}
          </span>
        ) : null}
        <span className="flex w-full items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground/60">
            #{issue.id.slice(0, 8)}
          </span>
          <IssueAssigneeFacepile
            assignees={issue.assignees}
            profiles={profiles}
          />
        </span>
      </button>
    </div>
  );
}

function BoardColumn({
  children,
  count,
  dragging,
  lockedReason,
  status,
}: {
  children: React.ReactNode;
  count: number;
  dragging: boolean;
  lockedReason?: string;
  status: ProjectIssueStatus;
}) {
  const visual = issueStatusVisual(status);
  const droppable = isIssueBoardDropStatus(status);
  const { isOver, setNodeRef } = useDroppable({
    disabled: !droppable,
    id: `${COLUMN_ID_PREFIX}${status}`,
    data: { type: "issue-column", status } satisfies IssueColumnDropData,
  });

  return (
    <section
      aria-label={`${status} tasks`}
      className="flex w-64 shrink-0 flex-col gap-2"
      data-testid="project-issue-board-column"
      data-status={status}
    >
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <ProjectStatusProgressIcon
          className={cn("h-3.5 w-3.5", visual.className)}
          state={visual.progress}
        />
        <span className="text-foreground">{status}</span>
        <span className="text-muted-foreground/60">{count}</span>
      </h3>
      <div
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-1.5 rounded-md p-1.5 transition-colors duration-100 motion-reduce:transition-none",
          droppable && isOver && "bg-muted/40 ring-2 ring-primary/30",
          dragging && !droppable && "opacity-50",
        )}
        data-testid="project-issue-board-column-body"
        ref={setNodeRef}
      >
        {dragging && !droppable ? (
          <p
            className="px-1 text-2xs text-muted-foreground/60"
            data-testid="project-issue-board-column-hint"
          >
            Set by labels — drop not available.
          </p>
        ) : null}
        {lockedReason ? (
          <p
            className="px-1 text-2xs text-muted-foreground/60"
            data-testid="project-issue-board-column-locked"
          >
            {lockedReason}
          </p>
        ) : null}
        {children}
      </div>
    </section>
  );
}

/**
 * Kanban view over the same six statuses the grouped task list renders.
 * Only the four columns backed by a NIP-34 status kind accept a drop; see
 * `issueBoardColumns.ts`.
 */
export function ProjectIssueBoard({
  canMoveIssue,
  items,
  moveLockedReason,
  onMoveIssue,
  onOpenIssue,
  profiles,
}: {
  canMoveIssue: (item: ProjectIssueBoardItem) => boolean;
  items: ProjectIssueBoardItem[];
  /**
   * When set, no card can be moved regardless of `canMoveIssue`, and every
   * column says why. For boards whose statuses are known to be incomplete:
   * a drop would publish an authoritative status over one the viewer never
   * saw.
   */
  moveLockedReason?: string;
  onMoveIssue: (
    item: ProjectIssueBoardItem,
    status: IssueBoardDropStatus,
  ) => void;
  onOpenIssue: (item: ProjectIssueBoardItem) => void;
  profiles?: UserProfileLookup;
}) {
  const locked = moveLockedReason !== undefined;
  const [activeIssueId, setActiveIssueId] = React.useState<string | null>(null);
  // Without these, dnd-kit announces the draggable id — a 64-char hex event id
  // read out one character at a time.
  const announcements = React.useMemo<Announcements>(() => {
    const titleFor = (id: string | number) =>
      items.find(({ issue }) => issue.id === id)?.issue.title ?? "task";
    const columnFor = (data: unknown) => {
      const column = data as IssueColumnDropData | undefined | null;
      return column?.type === "issue-column" ? column.status : null;
    };
    return {
      onDragStart: ({ active }) => `Picked up ${titleFor(active.id)}.`,
      onDragOver: ({ active, over }) => {
        const status = columnFor(over?.data.current);
        if (status === null)
          return `${titleFor(active.id)} is not over a column.`;
        return isIssueBoardDropStatus(status)
          ? `${titleFor(active.id)} is over ${status}.`
          : `${status} does not accept dropped tasks.`;
      },
      onDragEnd: ({ active, over }) => {
        const status = columnFor(over?.data.current);
        return status !== null && isIssueBoardDropStatus(status)
          ? `Moved ${titleFor(active.id)} to ${status}.`
          : `${titleFor(active.id)} was left where it was.`;
      },
      onDragCancel: ({ active }) =>
        `Cancelled. ${titleFor(active.id)} was left where it was.`,
    };
  }, [items]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: boardKeyboardCoordinates,
    }),
  );

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as IssueCardDragData | undefined;
    if (data?.type === "issue-card") setActiveIssueId(data.issueId);
  }, []);

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveIssueId(null);
      const activeData = event.active.data.current as
        | IssueCardDragData
        | undefined;
      const overData = event.over?.data.current as
        | IssueColumnDropData
        | undefined;
      if (activeData?.type !== "issue-card") return;
      const item = items.find(({ issue }) => issue.id === activeData.issueId);
      if (!item) return;
      const status = resolveIssueBoardDrop({
        currentStatus: item.issue.status,
        overStatus:
          overData?.type === "issue-column" ? overData.status : undefined,
        permitted: !locked && canMoveIssue(item),
      });
      if (status === null) return;
      onMoveIssue(item, status);
    },
    [canMoveIssue, items, locked, onMoveIssue],
  );

  const activeItem = activeIssueId
    ? (items.find(({ issue }) => issue.id === activeIssueId) ?? null)
    : null;

  return (
    <DndContext
      accessibility={{ announcements }}
      collisionDetection={boardCollisionDetection}
      onDragCancel={() => setActiveIssueId(null)}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4"
        data-testid="project-issue-board"
      >
        {ISSUE_BOARD_COLUMN_ORDER.map((status) => {
          const columnItems = items.filter(
            ({ issue }) => issue.status === status,
          );
          return (
            <BoardColumn
              count={columnItems.length}
              dragging={activeIssueId !== null}
              key={status}
              lockedReason={moveLockedReason}
              status={status}
            >
              {columnItems.map((item) => (
                <IssueCard
                  draggable={!locked && canMoveIssue(item)}
                  isDragging={item.issue.id === activeIssueId}
                  issue={item.issue}
                  key={item.issue.id}
                  onOpen={() => onOpenIssue(item)}
                  profiles={profiles}
                  projectName={item.projectName}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
      <DragOverlay>
        {activeItem ? (
          <div
            className="pointer-events-none w-64 rounded-md border border-border bg-background px-2 py-2 text-xs shadow-lg"
            data-buzz-flat
            data-testid="project-issue-board-drag-overlay"
          >
            <span className="line-clamp-2">{activeItem.issue.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
