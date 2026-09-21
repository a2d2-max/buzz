import type * as React from "react";
import { ISSUE_BOARD_COLUMN_ORDER } from "@/features/projects/lib/issueBoardColumns";
import { ProjectIssueBoard } from "@/features/projects/ui/ProjectIssueBoard";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import {
  DEFAULT_ISSUE_VIEW,
  filterCommunityIssues,
  type CommunityIssueViewItem,
  type CommunityIssueViewState,
} from "@/features/board/lib/communityIssueView";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  CommunityTaskAssigneeFacepile,
  communityTaskProfileLabel,
} from "./CommunityTaskAssignees";

const SELECT_CLASS =
  "h-8 max-w-48 rounded-md border border-border/60 bg-background px-2 text-xs";
type Props = Omit<React.ComponentProps<typeof ProjectIssueBoard>, "items"> & {
  items: CommunityIssueViewItem[];
  state: CommunityIssueViewState;
  setState: React.Dispatch<React.SetStateAction<CommunityIssueViewState>>;
  viewer: string | null;
};
export function CommunityIssuesView({
  items,
  state,
  setState,
  viewer,
  ...board
}: Props) {
  const filtered = filterCommunityIssues(items, state, viewer);
  const projects = new Map(
    items.map((item) => [item.projectId, item.projectName]),
  );
  if (state.project !== "all" && !projects.has(state.project))
    projects.set(state.project, "Unavailable project");
  const assignees = [
    ...new Set([
      ...items.flatMap((item) => item.issue.assignees),
      ...(!["all", "mine", "unassigned"].includes(state.assignee)
        ? [state.assignee]
        : []),
    ]),
  ];
  const active =
    state.search !== "" ||
    state.status !== "all" ||
    state.project !== "all" ||
    state.assignee !== "all";
  const patch = (next: Partial<CommunityIssueViewState>) =>
    setState((old) => ({ ...old, ...next }));
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3">
        <span
          className="mr-auto text-xs text-muted-foreground"
          aria-live="polite"
        >
          {filtered.length} of {items.length} issues
        </span>
        <fieldset aria-label="Issue layout" className="flex gap-1">
          <Button
            type="button"
            size="xs"
            variant={state.layout === "board" ? "secondary" : "ghost"}
            aria-label="Issue board view"
            aria-pressed={state.layout === "board"}
            onClick={() => patch({ layout: "board" })}
          >
            Board
          </Button>
          <Button
            type="button"
            size="xs"
            variant={state.layout === "list" ? "secondary" : "ghost"}
            aria-label="Issue list view"
            aria-pressed={state.layout === "list"}
            onClick={() => patch({ layout: "list" })}
          >
            List
          </Button>
        </fieldset>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 px-4 py-3">
        <Input
          type="search"
          aria-label="Search issues"
          placeholder="Search issues…"
          className="h-8 min-w-40 flex-1 text-xs"
          value={state.search}
          onChange={(event) => patch({ search: event.target.value })}
        />
        <select
          className={SELECT_CLASS}
          aria-label="Issue status"
          value={state.status}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === "all" ||
              ISSUE_BOARD_COLUMN_ORDER.some((status) => status === value)
            )
              patch({ status: value as CommunityIssueViewState["status"] });
          }}
        >
          <option value="all">All statuses</option>
          {ISSUE_BOARD_COLUMN_ORDER.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          aria-label="Issue assignee"
          value={state.assignee}
          onChange={(event) => patch({ assignee: event.target.value })}
        >
          <option value="all">All assignees</option>
          <option value="mine" disabled={!viewer}>
            Assigned to me
          </option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((key) => (
            <option key={key} value={key}>
              {communityTaskProfileLabel(key, board.profiles)}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          aria-label="Issue project"
          value={state.project}
          onChange={(event) => patch({ project: event.target.value })}
        >
          <option value="all">All projects</option>
          {[...projects].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              setState({ ...DEFAULT_ISSUE_VIEW, layout: state.layout })
            }
          >
            Clear issue filters
          </Button>
        ) : null}
      </div>
      {!filtered.length ? (
        <ProjectPanelState
          panel={false}
          title="No matching issues"
          description="Change or clear the filters to see more issues."
        />
      ) : state.layout === "board" ? (
        <ProjectIssueBoard {...board} items={filtered} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto px-4 pb-4"
          data-testid="community-issues-list"
        >
          <table className="w-full min-w-[40rem] text-left text-xs">
            <caption className="sr-only">Issues</caption>
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                {["Issue", "Project / repository", "Status", "Assignees"].map(
                  (label) => (
                    <th
                      key={label}
                      scope="col"
                      className="px-3 py-2 font-medium"
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr
                  key={`${item.projectId}:${item.issue.id}`}
                  className="border-t border-border/40 hover:bg-muted/30"
                >
                  <td className="max-w-md px-3 py-2">
                    <button
                      type="button"
                      aria-label={`Open ${item.issue.title || "Untitled issue"}`}
                      className="w-full truncate rounded py-1 text-left font-medium focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => board.onOpenIssue(item)}
                    >
                      {item.issue.title || "Untitled issue"}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block">{item.projectName}</span>
                    <span className="text-muted-foreground">
                      {item.project.name}
                    </span>
                  </td>
                  <td className="px-3 py-2">{item.issue.status}</td>
                  <td className="px-3 py-2">
                    {item.issue.assignees.length ? (
                      <CommunityTaskAssigneeFacepile
                        assignees={item.issue.assignees}
                        profiles={board.profiles}
                      />
                    ) : (
                      "Unassigned"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
