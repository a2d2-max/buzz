import { Columns3, List, Search, CalendarDays } from "lucide-react";
import * as React from "react";
import {
  COMMUNITY_TASK_COLUMN_ORDER,
  COMMUNITY_TASK_STATUS_LABELS,
} from "@/features/board/lib/communityTaskColumns";
import { isCommunityTaskStatus } from "@/features/board/lib/communityTaskCodec";
import {
  compareCommunityTasksForView,
  DEFAULT_COMMUNITY_TASK_FILTERS,
  filterCommunityTasks,
  type CommunityTaskFilters,
  type CommunityTaskSort,
} from "@/features/board/lib/communityTaskView";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { communityTaskProfileLabel } from "./CommunityTaskAssignees";
import { CommunityTasksBoard } from "./CommunityTasksBoard";
import { CommunityTasksList } from "./CommunityTasksList";

import { CommunityTasksTimeline } from "./CommunityTasksTimeline";

import {
  MAX_VIEW_SEARCH,
  communityTaskSavedViewsKey,
} from "../lib/communityTaskSavedViews";
import { CommunityTaskSyncedViews } from "./CommunityTaskSyncedViews";

const SELECT_CLASS =
  "h-8 min-w-0 rounded-md border border-border/60 bg-background px-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

type Props = React.ComponentProps<typeof CommunityTasksBoard> & {
  newTaskButton: React.ReactNode;
  viewer: string | null;
  relayUrl: string;
};

/** Shared exploration state for kanban and list; writes stay in the parent panel. */
export function CommunityTasksView(props: Props) {
  return (
    <ScopedCommunityTasksView
      key={JSON.stringify([props.relayUrl, props.viewer])}
      {...props}
    />
  );
}

function ScopedCommunityTasksView({
  tasks,
  profiles,
  onOpenTask,
  newTaskButton,
  viewer,
  relayUrl,
  ...boardProps
}: Props) {
  const [layout, setLayout] = React.useState<"board" | "list" | "timeline">(
    "board",
  );
  const [filters, setFilters] = React.useState<CommunityTaskFilters>(
    DEFAULT_COMMUNITY_TASK_FILTERS,
  );
  const [sort, setSort] = React.useState<CommunityTaskSort>("manual");
  const storageKey = communityTaskSavedViewsKey(relayUrl, viewer);
  const [now, setNow] = React.useState(() => Date.now() / 1_000);
  React.useEffect(() => {
    const refresh = () => setNow(Date.now() / 1_000);
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const compareTasks = React.useCallback(
    (a: Props["tasks"][number], b: Props["tasks"][number]) =>
      compareCommunityTasksForView(a, b, sort),
    [sort],
  );
  const filtered = React.useMemo(
    () => filterCommunityTasks(tasks, filters, viewer, now).sort(compareTasks),
    [tasks, filters, viewer, now, compareTasks],
  );
  const assignees = React.useMemo(
    () =>
      [
        ...new Set([
          ...tasks.flatMap((task) => task.assignees),
          ...(!["all", "mine", "unassigned"].includes(filters.assignee)
            ? [filters.assignee]
            : []),
        ]),
      ].sort((a, b) =>
        communityTaskProfileLabel(a, profiles).localeCompare(
          communityTaskProfileLabel(b, profiles),
        ),
      ),
    [tasks, profiles, filters.assignee],
  );
  const filteredByUser =
    filters.search !== "" ||
    filters.status !== "all" ||
    filters.assignee !== "all" ||
    filters.due !== "all";
  const patch = (changes: Partial<CommunityTaskFilters>) =>
    setFilters((current) => ({ ...current, ...changes }));

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {filteredByUser
            ? `${filtered.length} of ${tasks.length} tasks`
            : tasks.length === 1
              ? "1 task"
              : `${tasks.length} tasks`}
        </p>
        <div className="flex items-center gap-2">
          <fieldset
            className="flex items-center gap-1 rounded-lg bg-muted/40 p-0.5"
            aria-label="Task layout"
          >
            <Button
              size="xs"
              variant={layout === "board" ? "secondary" : "ghost"}
              aria-label="Board view"
              aria-pressed={layout === "board"}
              onClick={() => setLayout("board")}
              type="button"
            >
              <Columns3 aria-hidden="true" />
              Board
            </Button>
            <Button
              size="xs"
              variant={layout === "list" ? "secondary" : "ghost"}
              aria-label="List view"
              aria-pressed={layout === "list"}
              onClick={() => setLayout("list")}
              type="button"
            >
              <List aria-hidden="true" />
              List
            </Button>
            <Button
              size="xs"
              type="button"
              variant={layout === "timeline" ? "secondary" : "ghost"}
              aria-label="Timeline view"
              aria-pressed={layout === "timeline"}
              onClick={() => setLayout("timeline")}
            >
              <CalendarDays aria-hidden="true" />
              Timeline
            </Button>
          </fieldset>
          {newTaskButton}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3">
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground"
          />
          <Input
            aria-label="Search tasks"
            className="h-8 pl-8 text-xs"
            type="search"
            maxLength={MAX_VIEW_SEARCH}
            placeholder="Search tasks…"
            value={filters.search}
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <select
          aria-label="Filter by status"
          className={SELECT_CLASS}
          value={filters.status}
          onChange={(event) => {
            const status = event.target.value;
            if (status === "all" || isCommunityTaskStatus(status))
              patch({ status });
          }}
        >
          <option value="all">All statuses</option>
          {COMMUNITY_TASK_COLUMN_ORDER.map((status) => (
            <option key={status} value={status}>
              {COMMUNITY_TASK_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by assignee"
          className={`${SELECT_CLASS} max-w-48`}
          value={filters.assignee}
          onChange={(event) => patch({ assignee: event.target.value })}
        >
          <option value="all">All assignees</option>
          <option value="mine" disabled={!viewer}>
            Assigned to me
          </option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((key) => (
            <option key={key} value={key}>
              {communityTaskProfileLabel(key, profiles)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by due date"
          className={SELECT_CLASS}
          value={filters.due}
          onChange={(event) => {
            const due = event.target.value;
            if (
              due === "all" ||
              due === "overdue" ||
              due === "today" ||
              due === "none"
            )
              patch({ due });
          }}
        >
          <option value="all">All due dates</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="none">No due date</option>
        </select>
        <select
          aria-label="Sort tasks"
          className={SELECT_CLASS}
          value={sort}
          onChange={(event) => {
            const next = event.target.value;
            if (
              next === "manual" ||
              next === "due" ||
              next === "updated" ||
              next === "title"
            )
              setSort(next);
          }}
        >
          <option value="manual">Board order</option>
          <option value="due">Due date</option>
          <option value="updated">Recently updated</option>
          <option value="title">Title</option>
        </select>
        {filteredByUser ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setFilters(DEFAULT_COMMUNITY_TASK_FILTERS)}
            type="button"
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {storageKey ? (
        <CommunityTaskSyncedViews
          user={viewer ?? ""}
          storageKey={storageKey}
          settings={{ layout, filters, sort }}
          onApply={(view) => {
            setLayout(view.layout);
            setFilters(view.filters);
            setSort(view.sort);
          }}
        />
      ) : null}
      {filtered.length === 0 ? (
        <ProjectPanelState
          panel={false}
          testId={tasks.length === 0 ? "community-tasks-empty" : undefined}
          title={tasks.length === 0 ? "No tasks yet" : "No matching tasks"}
          description={
            tasks.length === 0
              ? "Tasks anyone here creates will show up on this board."
              : "Change or clear the filters to see more tasks."
          }
        />
      ) : layout === "timeline" ? (
        <CommunityTasksTimeline
          tasks={filtered}
          profiles={profiles}
          onOpenTask={onOpenTask}
        />
      ) : layout === "list" ? (
        <CommunityTasksList
          tasks={filtered}
          profiles={profiles}
          onOpenTask={onOpenTask}
        />
      ) : (
        <CommunityTasksBoard
          {...boardProps}
          tasks={filtered}
          profiles={profiles}
          onOpenTask={onOpenTask}
          compareTasks={compareTasks}
        />
      )}
    </>
  );
}
