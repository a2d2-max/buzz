import {
  COMMUNITY_TASK_STATUSES,
  type CommunityTaskStatus,
} from "./communityTaskCodec";
import type { CommunityTask } from "./communityTaskMerge";

/** Left-to-right board order. Every column accepts a drop. */
export const COMMUNITY_TASK_COLUMN_ORDER: readonly CommunityTaskStatus[] =
  COMMUNITY_TASK_STATUSES;

export const COMMUNITY_TASK_STATUS_LABELS: Record<CommunityTaskStatus, string> =
  {
    todo: "To Do",
    doing: "Doing",
    done: "Done",
  };

/**
 * The status a finished drag should publish, or null when the drag is a
 * no-op: dropped outside every column, dropped back on its own column, or
 * moved by a viewer who may not. The permission check lives here so the
 * pointer and keyboard paths cannot disagree about it.
 */
export function resolveCommunityTaskDrop({
  currentStatus,
  overStatus,
  permitted,
}: {
  currentStatus: CommunityTaskStatus;
  overStatus: CommunityTaskStatus | undefined;
  permitted: boolean;
}): CommunityTaskStatus | null {
  if (!permitted || overStatus === undefined) return null;
  return overStatus === currentStatus ? null : overStatus;
}

/** Column order: lowest `order` first, then oldest card, then id. */
export function compareCommunityTasksInColumn(
  a: Pick<CommunityTask, "order" | "createdAt" | "id">,
  b: Pick<CommunityTask, "order" | "createdAt" | "id">,
): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * An `order` that sorts after everything already on the board — a new card
 * joins the bottom of its column, and so does a card dropped into one.
 */
export function nextCommunityTaskOrder(nowMs = Date.now()): number {
  return nowMs;
}

export function communityTasksByStatus(
  tasks: readonly CommunityTask[],
): Record<CommunityTaskStatus, CommunityTask[]> {
  const columns: Record<CommunityTaskStatus, CommunityTask[]> = {
    todo: [],
    doing: [],
    done: [],
  };
  for (const task of tasks) columns[task.status].push(task);
  for (const status of COMMUNITY_TASK_COLUMN_ORDER) {
    columns[status].sort(compareCommunityTasksInColumn);
  }
  return columns;
}
