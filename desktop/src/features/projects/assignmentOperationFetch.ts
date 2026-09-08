import type { RelayEvent } from "@/shared/api/types";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import {
  ISSUE_ASSIGNMENT_LABEL,
  ISSUE_UNASSIGNMENT_LABEL,
} from "./projectIssues.mjs";
import {
  type FetchEvents,
  fetchRootTaggedEvents,
} from "./rootTaggedEventFetch";

function isAssignmentOperation(event: RelayEvent): boolean {
  return event.tags.some(
    (tag) =>
      tag[0] === "t" &&
      (tag[1] === ISSUE_ASSIGNMENT_LABEL ||
        tag[1] === ISSUE_UNASSIGNMENT_LABEL),
  );
}

/**
 * Loads every assignment/unassignment operation for the given issues,
 * paginating to exhaustion instead of trusting a bounded comment window.
 *
 * Why: assignment state is reduced from kind:1 operations (`t: assignment` /
 * `t: unassignment`), but the general comment fetches are bounded (500 per
 * repo in `hooks.ts`, 2,000 shared in `projectWorkItems.ts`). Once newer
 * comments push an older operation out of that window, its assignee silently
 * vanishes from the issue — and a later self-service operation can reduce
 * against the wrong `prior` head.
 *
 * The query walks the full comment stream of the given issues (`#e` is the
 * only tag constraint the relay applies before its SQL `LIMIT`) and the
 * assignment labels are filtered locally; see `fetchRootTaggedEvents`.
 */
export async function fetchAssignmentOperationEvents(
  issueIds: string[],
  fetchEvents?: FetchEvents,
  signal?: AbortSignal,
): Promise<RelayEvent[]> {
  const comments = await fetchRootTaggedEvents({
    fetchEvents,
    kinds: [KIND_TEXT_NOTE],
    rootIds: issueIds,
    signal,
    subject: { history: "assignment history", rows: "issue comments" },
  });
  return comments.filter(isAssignmentOperation);
}

/** Merge two event lists, dropping duplicates by event id. */
export function mergeEventsById(
  base: RelayEvent[],
  extra: RelayEvent[],
): RelayEvent[] {
  const ids = new Set(base.map((event) => event.id));
  return [...base, ...extra.filter((event) => !ids.has(event.id))];
}
