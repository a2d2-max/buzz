import * as React from "react";
import type { CommunityTask } from "@/features/board/lib/communityTaskMerge";
import {
  timelineWeekStart,
  timelineDays,
  tasksOnTimelineDay,
  TIMELINE_DAY_SECONDS,
} from "@/features/board/lib/communityTaskTimeline";
import {
  dueToDateInputValue,
  dateInputValueToDue,
} from "@/features/board/lib/communityTaskDue";
import { COMMUNITY_TASK_STATUS_LABELS } from "@/features/board/lib/communityTaskColumns";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { Button } from "@/shared/ui/button";
import { CommunityTasksList } from "./CommunityTasksList";

const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Deadlines are single calendar days; no invented start dates or durations. */
export function CommunityTasksTimeline({
  tasks,
  profiles,
  onOpenTask,
}: {
  tasks: CommunityTask[];
  profiles?: UserProfileLookup;
  onOpenTask: (task: CommunityTask) => void;
}) {
  const [start, setStart] = React.useState(() => timelineWeekStart());
  const days = timelineDays(start);
  const undated = tasks.filter((task) => task.due === undefined);
  const outside = tasks.filter(
    (task) =>
      task.due !== undefined &&
      (task.due < start || task.due >= start + 7 * TIMELINE_DAY_SECONDS),
  ).length;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-4 pb-4"
      data-testid="community-tasks-timeline"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => setStart((value) => value - 7 * TIMELINE_DAY_SECONDS)}
        >
          Previous week
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setStart(timelineWeekStart())}
        >
          This week
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setStart((value) => value + 7 * TIMELINE_DAY_SECONDS)}
        >
          Next week
        </Button>
        <label className="flex items-center gap-2 text-xs">
          Week starting
          <input
            type="date"
            aria-label="Timeline start date"
            value={dueToDateInputValue(start)}
            className="rounded border border-border bg-background p-1 text-xs"
            onChange={(event) => {
              const due = dateInputValueToDue(event.target.value);
              if (due !== undefined) setStart(due);
            }}
          />
        </label>
        <span className="text-xs text-muted-foreground" role="status">
          {outside} dated tasks outside this week
        </span>
      </div>
      <fieldset
        className="grid min-w-[56rem] grid-cols-7 gap-2"
        aria-label="Task deadlines"
      >
        {days.map((day) => (
          <section
            key={day}
            className="min-h-48 rounded-lg border border-border/60 bg-muted/10 p-2"
            aria-label={dueToDateInputValue(day)}
          >
            <h3 className="mb-2 text-xs font-medium">
              <time dateTime={dueToDateInputValue(day)}>
                {dayLabel.format(new Date(day * 1_000))}
              </time>
            </h3>
            <ul className="space-y-2">
              {tasksOnTimelineDay(tasks, day).map((task) => (
                <li key={task.key}>
                  <button
                    type="button"
                    aria-label={`Open ${task.title || "Untitled task"}`}
                    className="w-full rounded-md border border-border bg-background p-2 text-left text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onOpenTask(task)}
                  >
                    <span className="block break-words font-medium">
                      {task.title || "Untitled task"}
                    </span>
                    <span className="text-muted-foreground">
                      {COMMUNITY_TASK_STATUS_LABELS[task.status]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </fieldset>
      <h3 className="mb-2 mt-4 text-xs font-medium">
        No due date ({undated.length})
      </h3>
      {undated.length ? (
        <CommunityTasksList
          tasks={undated}
          profiles={profiles}
          onOpenTask={onOpenTask}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          All matching tasks have a due date.
        </p>
      )}
    </div>
  );
}
