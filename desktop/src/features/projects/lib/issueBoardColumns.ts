import {
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_OPEN,
} from "@/shared/constants/kinds";
import type { ProjectIssueStatus } from "../projectIssues.mjs";

/**
 * Protocol word for a NIP-34 status kind, as the Tauri signing commands take
 * it. Mirrors the pull-request contract (`sign_project_pull_request_status`);
 * 1631 is "merged" for a pull request and "resolved" for a task.
 */
export type ProjectIssueStatusWord = "open" | "draft" | "resolved" | "closed";

/**
 * Board columns backed by a publishable NIP-34 status kind.
 *
 * `In Progress` and `In Review` are label-derived heuristics in
 * `statusFromEvent` (projectIssues.mjs), not protocol states — there is no
 * status event that reproduces them, so those columns render cards but never
 * accept a drop.
 */
const ISSUE_BOARD_DROP_TARGETS = {
  Backlog: { kind: KIND_GIT_STATUS_OPEN, word: "open" },
  Triage: { kind: KIND_GIT_STATUS_DRAFT, word: "draft" },
  Done: { kind: KIND_GIT_STATUS_MERGED, word: "resolved" },
  Closed: { kind: KIND_GIT_STATUS_CLOSED, word: "closed" },
} as const satisfies Partial<
  Record<ProjectIssueStatus, { kind: number; word: ProjectIssueStatusWord }>
>;

export type IssueBoardDropStatus = keyof typeof ISSUE_BOARD_DROP_TARGETS;

/** Left-to-right workflow order for the board, newest work first on the left. */
export const ISSUE_BOARD_COLUMN_ORDER: readonly ProjectIssueStatus[] = [
  "Backlog",
  "Triage",
  "In Progress",
  "In Review",
  "Done",
  "Closed",
];

/** The kind + protocol word a drop into `status` publishes, or null. */
export function issueBoardDropTarget(
  status: ProjectIssueStatus,
): { kind: number; word: ProjectIssueStatusWord } | null {
  return ISSUE_BOARD_DROP_TARGETS[status as IssueBoardDropStatus] ?? null;
}

export function isIssueBoardDropStatus(
  status: ProjectIssueStatus,
): status is IssueBoardDropStatus {
  return issueBoardDropTarget(status) !== null;
}

/**
 * The status a completed drag should publish, or null when the drag is a
 * no-op: an unknown drop target, a label-only column, or the card's own
 * column. `permitted` is the viewer check, kept here so the pointer and the
 * keyboard path cannot disagree about who may move a card.
 */
export function resolveIssueBoardDrop({
  currentStatus,
  overStatus,
  permitted,
}: {
  currentStatus: ProjectIssueStatus;
  overStatus: ProjectIssueStatus | undefined;
  permitted: boolean;
}): IssueBoardDropStatus | null {
  if (!permitted || overStatus === undefined) return null;
  if (!isIssueBoardDropStatus(overStatus)) return null;
  return overStatus === currentStatus ? null : overStatus;
}
