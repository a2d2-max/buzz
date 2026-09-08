import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  type LucideIcon,
} from "lucide-react";

import type { ProjectStatusProgressState } from "../ui/ProjectStatusProgressIcon";
import type { ProjectIssueStatus } from "../projectIssues.mjs";

/**
 * One source of truth for how a task status is drawn. The grouped list
 * (`ProjectIssuesPanel`) and the kanban board (`ProjectIssueBoard`) render
 * the same six statuses, so they must agree on order, colour, and icon.
 */
export function issueStatusClassName(status: ProjectIssueStatus): string {
  if (status === "Triage" || status === "In Progress") return "text-amber-500";
  if (status === "Backlog") return "text-muted-foreground";
  if (status === "In Review") return "text-green-500";
  if (status === "Done") return "text-purple-400";
  if (status === "Closed") return "text-destructive";
  return "text-muted-foreground";
}

export function issueStatusVisual(status: ProjectIssueStatus): {
  className: string;
  icon: LucideIcon;
  progress: ProjectStatusProgressState;
} {
  if (status === "Done") {
    return {
      className: "text-purple-400",
      icon: CircleCheck,
      progress: "completed",
    };
  }
  if (status === "Closed") {
    return {
      className: "text-destructive",
      icon: CircleX,
      progress: "canceled",
    };
  }
  if (status === "Backlog") {
    return {
      className: issueStatusClassName(status),
      icon: Circle,
      progress: "queued",
    };
  }
  if (status === "Triage") {
    return {
      className: issueStatusClassName(status),
      icon: CircleDashed,
      progress: "queued",
    };
  }
  return {
    className: issueStatusClassName(status),
    icon: CircleDot,
    progress: status === "In Review" ? "review" : "started",
  };
}

export const ISSUE_STATUS_ORDER: readonly ProjectIssueStatus[] = [
  "In Review",
  "In Progress",
  "Triage",
  "Backlog",
  "Done",
  "Closed",
];
