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
import { CalendarDays, GripVertical } from "lucide-react";
import * as React from "react";

import type { CommunityTaskStatus } from "@/features/board/lib/communityTaskCodec";
import {
  COMMUNITY_TASK_COLUMN_ORDER,
  COMMUNITY_TASK_STATUS_LABELS,
  compareCommunityTasksInColumn,
  communityTasksByStatus,
  resolveCommunityTaskDrop,
} from "@/features/board/lib/communityTaskColumns";
import {
  formatCommunityTaskDue,
  isCommunityTaskOverdue,
} from "@/features/board/lib/communityTaskDue";
import type { CommunityTask } from "@/features/board/lib/communityTaskMerge";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { CommunityTaskAssigneeFacepile } from "./CommunityTaskAssignees";

type TaskCardDragData = { type: "community-task-card"; taskKey: string };
type TaskColumnDropData = {
  type: "community-task-column";
  status: CommunityTaskStatus;
};

const COLUMN_ID_PREFIX = "community-task-column:";
/** `w-64` column plus the `gap-3` between them, so one arrow press = one column. */
const COLUMN_STEP_PX = 268;
const CARD_STEP_PX = 48;

// `pointerWithin` needs pointer coordinates, and a KeyboardEvent has none — on
// the keyboard path it always returns nothing, so a keyboard drop would never
// find a column. Fall back to rectangle overlap there.
const boardCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

// The stock keyboard getter nudges 25px per press, which needs ten presses to
// cross a column. Step by the real layout instead so the keyboard path lands
// where the pointer path does.
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

function titleOf(task: Pick<CommunityTask, "title">): string {
  return task.title.trim() || "Untitled task";
}

export function CommunityTaskDueChip({
  status,
  due,
}: {
  status: CommunityTaskStatus;
  due: number;
}) {
  const overdue = status !== "done" && isCommunityTaskOverdue(due);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-2xs",
        overdue ? "text-destructive" : "text-muted-foreground/70",
      )}
      data-overdue={overdue ? "" : undefined}
      data-testid="community-task-due"
    >
      <CalendarDays aria-hidden="true" className="h-3 w-3" />
      {formatCommunityTaskDue(due)}
    </span>
  );
}

function TaskCard({
  draggable,
  isDragging,
  onOpen,
  profiles,
  task,
}: {
  draggable: boolean;
  isDragging?: boolean;
  onOpen: () => void;
  profiles?: UserProfileLookup;
  task: CommunityTask;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef } =
    useDraggable({
      disabled: !draggable,
      id: task.key,
      data: {
        type: "community-task-card",
        taskKey: task.key,
      } satisfies TaskCardDragData,
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
      data-drag-state={isDragging ? "dragging" : undefined}
      data-task-id={task.id}
      data-task-key={task.key}
      data-testid="community-task-card"
      ref={setNodeRef}
    >
      {draggable ? (
        <button
          aria-label={`Move ${titleOf(task)}`}
          className="mt-0.5 shrink-0 cursor-grab touch-none rounded text-muted-foreground/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="community-task-drag-handle"
          ref={setActivatorNodeRef}
          type="button"
          {...dragHandleAttributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
      <button
        className="flex min-w-0 flex-1 flex-col items-start gap-1.5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="community-task-card-open"
        onClick={onOpen}
        type="button"
      >
        <span className="line-clamp-2 min-w-0 text-xs text-foreground">
          {titleOf(task)}
        </span>
        {task.due !== undefined || task.assignees.length > 0 ? (
          <span className="flex w-full items-center justify-between gap-2">
            {task.due !== undefined ? (
              <CommunityTaskDueChip due={task.due} status={task.status} />
            ) : (
              <span />
            )}
            <CommunityTaskAssigneeFacepile
              assignees={task.assignees}
              profiles={profiles}
            />
          </span>
        ) : null}
      </button>
    </div>
  );
}

function BoardColumn({
  children,
  count,
  status,
}: {
  children: React.ReactNode;
  count: number;
  status: CommunityTaskStatus;
}) {
  const label = COMMUNITY_TASK_STATUS_LABELS[status];
  const { isOver, setNodeRef } = useDroppable({
    id: `${COLUMN_ID_PREFIX}${status}`,
    data: {
      type: "community-task-column",
      status,
    } satisfies TaskColumnDropData,
  });

  return (
    <section
      aria-label={`${label} tasks`}
      className="flex w-64 shrink-0 flex-col gap-2"
      data-status={status}
      data-testid="community-task-column"
    >
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <span className="text-foreground">{label}</span>
        <span className="text-muted-foreground/60">{count}</span>
      </h3>
      <div
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-1.5 rounded-md p-1.5 transition-colors duration-100 motion-reduce:transition-none",
          isOver && "bg-muted/40 ring-2 ring-primary/30",
        )}
        data-testid="community-task-column-body"
        ref={setNodeRef}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Presentational kanban over the three task statuses. Every column accepts
 * a drop; who may move a card is the caller's decision (`canMoveTask`), and
 * the data + permissions wrapper is `CommunityTasksBoardPanel`.
 */
export function CommunityTasksBoard({
  canMoveTask,
  compareTasks = compareCommunityTasksInColumn,
  onMoveTask,
  onOpenTask,
  profiles,
  tasks,
}: {
  canMoveTask: (task: CommunityTask) => boolean;
  compareTasks?: (a: CommunityTask, b: CommunityTask) => number;
  onMoveTask: (task: CommunityTask, status: CommunityTaskStatus) => void;
  onOpenTask: (task: CommunityTask) => void;
  profiles?: UserProfileLookup;
  tasks: CommunityTask[];
}) {
  const [activeTaskKey, setActiveTaskKey] = React.useState<string | null>(null);
  const columns = React.useMemo(() => {
    const grouped = communityTasksByStatus(tasks);
    for (const status of COMMUNITY_TASK_COLUMN_ORDER)
      grouped[status].sort(compareTasks);
    return grouped;
  }, [tasks, compareTasks]);

  // Without these, dnd-kit announces the draggable id — a UUID read out one
  // character at a time.
  const announcements = React.useMemo<Announcements>(() => {
    const titleFor = (key: string | number) => {
      const task = tasks.find((candidate) => candidate.key === key);
      return task ? titleOf(task) : "task";
    };
    const columnFor = (data: unknown) => {
      const column = data as TaskColumnDropData | undefined | null;
      return column?.type === "community-task-column"
        ? COMMUNITY_TASK_STATUS_LABELS[column.status]
        : null;
    };
    return {
      onDragStart: ({ active }) => `Picked up ${titleFor(active.id)}.`,
      onDragOver: ({ active, over }) => {
        const label = columnFor(over?.data.current);
        return label === null
          ? `${titleFor(active.id)} is not over a column.`
          : `${titleFor(active.id)} is over ${label}.`;
      },
      onDragEnd: ({ active, over }) => {
        const label = columnFor(over?.data.current);
        return label === null
          ? `${titleFor(active.id)} was left where it was.`
          : `Moved ${titleFor(active.id)} to ${label}.`;
      },
      onDragCancel: ({ active }) =>
        `Cancelled. ${titleFor(active.id)} was left where it was.`,
    };
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: boardKeyboardCoordinates,
    }),
  );

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as TaskCardDragData | undefined;
    if (data?.type === "community-task-card") setActiveTaskKey(data.taskKey);
  }, []);

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveTaskKey(null);
      const activeData = event.active.data.current as
        | TaskCardDragData
        | undefined;
      const overData = event.over?.data.current as
        | TaskColumnDropData
        | undefined;
      if (activeData?.type !== "community-task-card") return;
      const task = tasks.find(
        (candidate) => candidate.key === activeData.taskKey,
      );
      if (!task) return;
      const status = resolveCommunityTaskDrop({
        currentStatus: task.status,
        overStatus:
          overData?.type === "community-task-column"
            ? overData.status
            : undefined,
        permitted: canMoveTask(task),
      });
      if (status === null) return;
      onMoveTask(task, status);
    },
    [canMoveTask, onMoveTask, tasks],
  );

  const activeTask = activeTaskKey
    ? (tasks.find((task) => task.key === activeTaskKey) ?? null)
    : null;

  return (
    <DndContext
      accessibility={{ announcements }}
      collisionDetection={boardCollisionDetection}
      onDragCancel={() => setActiveTaskKey(null)}
      onDragEnd={handleDragEnd}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4"
        data-testid="community-tasks-board"
      >
        {COMMUNITY_TASK_COLUMN_ORDER.map((status) => {
          const columnTasks = columns[status];
          return (
            <BoardColumn
              count={columnTasks.length}
              key={status}
              status={status}
            >
              {columnTasks.map((task) => (
                <TaskCard
                  draggable={canMoveTask(task)}
                  isDragging={task.key === activeTaskKey}
                  key={task.key}
                  onOpen={() => onOpenTask(task)}
                  profiles={profiles}
                  task={task}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
      <DragOverlay>
        {activeTask ? (
          <div
            className="pointer-events-none w-64 rounded-md border border-border bg-background px-2 py-2 text-xs shadow-lg"
            data-buzz-flat
            data-testid="community-task-drag-overlay"
          >
            <span className="line-clamp-2">{titleOf(activeTask)}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
