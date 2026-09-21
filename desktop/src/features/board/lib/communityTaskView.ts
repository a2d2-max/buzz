import { normalizePubkey } from "@/shared/lib/pubkey";
import type { CommunityTaskStatus } from "./communityTaskCodec";
import { compareCommunityTasksInColumn } from "./communityTaskColumns";
import { isCommunityTaskOverdue } from "./communityTaskDue";
import type { CommunityTask } from "./communityTaskMerge";

export type CommunityTaskSort = "manual" | "due" | "updated" | "title";
export type CommunityTaskDueFilter = "all" | "overdue" | "today" | "none";
export type CommunityTaskFilters = {
  search: string;
  status: "all" | CommunityTaskStatus;
  assignee: string;
  due: CommunityTaskDueFilter;
};

export const DEFAULT_COMMUNITY_TASK_FILTERS: CommunityTaskFilters = {
  search: "",
  status: "all",
  assignee: "all",
  due: "all",
};

/** Filter the current community's cards without changing the source data. */
export function filterCommunityTasks(
  tasks: readonly CommunityTask[],
  filters: CommunityTaskFilters,
  viewer: string | null,
  nowSeconds: number,
): CommunityTask[] {
  const search = filters.search.trim().toLocaleLowerCase();
  const now = new Date(nowSeconds * 1_000);
  const today =
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 1_000;
  return tasks.filter((task) => {
    if (
      search &&
      !`${task.title}\n${task.body}`.toLocaleLowerCase().includes(search)
    )
      return false;
    if (filters.status !== "all" && task.status !== filters.status)
      return false;
    if (filters.assignee === "unassigned") {
      if (task.assignees.length > 0) return false;
    } else if (filters.assignee !== "all") {
      const assignee = filters.assignee === "mine" ? viewer : filters.assignee;
      if (
        !assignee ||
        !task.assignees.some(
          (key) => normalizePubkey(key) === normalizePubkey(assignee),
        )
      )
        return false;
    }
    switch (filters.due) {
      case "overdue":
        return (
          task.status !== "done" &&
          task.due !== undefined &&
          isCommunityTaskOverdue(task.due, nowSeconds)
        );
      case "today":
        return (
          task.due !== undefined &&
          Math.floor(task.due / 86_400) === Math.floor(today / 86_400)
        );
      case "none":
        return task.due === undefined;
      default:
        return true;
    }
  });
}

/** View sorting never rewrites a card's persisted position. Undated cards sort last. */
export function compareCommunityTasksForView(
  a: CommunityTask,
  b: CommunityTask,
  sort: CommunityTaskSort,
): number {
  let difference = 0;
  if (sort === "due") {
    if (a.due === undefined && b.due !== undefined) return 1;
    if (b.due === undefined && a.due !== undefined) return -1;
    difference = (a.due ?? 0) - (b.due ?? 0);
  } else if (sort === "updated") {
    difference = b.updatedAt - a.updatedAt;
  } else if (sort === "title") {
    difference = a.title.localeCompare(b.title);
  }
  return (
    difference ||
    compareCommunityTasksInColumn(a, b) ||
    a.key.localeCompare(b.key)
  );
}
