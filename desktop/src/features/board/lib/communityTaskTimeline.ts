import type { CommunityTask } from "./communityTaskMerge";

export const TIMELINE_DAY_SECONDS = 86_400;
/** Convert the viewer's current date to the existing UTC calendar-date wire format. */
export function timelineWeekStart(nowSeconds = Date.now() / 1_000): number {
  const now = new Date(nowSeconds * 1_000);
  const day =
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 1_000;
  const weekday = new Date(day * 1_000).getUTCDay();
  return day - ((weekday + 6) % 7) * TIMELINE_DAY_SECONDS;
}
export function timelineDays(start: number): number[] {
  return Array.from({ length: 7 }, (_, i) => start + i * TIMELINE_DAY_SECONDS);
}
export function tasksOnTimelineDay(
  tasks: readonly CommunityTask[],
  day: number,
): CommunityTask[] {
  return tasks.filter(
    (task) =>
      task.due !== undefined &&
      task.due >= day &&
      task.due < day + TIMELINE_DAY_SECONDS,
  );
}
