import type { ProjectIssueBoardItem } from "@/features/projects/ui/ProjectIssueBoard";
import type { ProjectIssueStatus } from "@/features/projects/projectIssues.mjs";
import { normalizePubkey } from "@/shared/lib/pubkey";
export type CommunityIssueViewItem = ProjectIssueBoardItem & {
  projectId: string;
};
export type CommunityIssueViewState = {
  layout: "board" | "list";
  search: string;
  status: "all" | ProjectIssueStatus;
  assignee: string;
  project: string;
};
export const DEFAULT_ISSUE_VIEW: CommunityIssueViewState = {
  layout: "board",
  search: "",
  status: "all",
  assignee: "all",
  project: "all",
};
export function filterCommunityIssues(
  items: readonly CommunityIssueViewItem[],
  filters: CommunityIssueViewState,
  viewer: string | null,
): CommunityIssueViewItem[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const issue = item.issue;
    if (
      query &&
      ![issue.title, issue.content, ...issue.labels]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
    )
      return false;
    if (filters.status !== "all" && issue.status !== filters.status)
      return false;
    if (filters.project !== "all" && item.projectId !== filters.project)
      return false;
    if (filters.assignee === "unassigned") return issue.assignees.length === 0;
    if (filters.assignee !== "all") {
      const who = filters.assignee === "mine" ? viewer : filters.assignee;
      if (
        !who ||
        !issue.assignees.some(
          (key) => normalizePubkey(key) === normalizePubkey(who),
        )
      )
        return false;
    }
    return true;
  });
}
