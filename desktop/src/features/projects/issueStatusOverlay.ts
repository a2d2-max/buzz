import * as React from "react";

import {
  nextProjectIssueStatusCreatedAt,
  type ProjectIssue,
  type ProjectIssueStatus,
} from "./projectIssues.mjs";

/**
 * A status the viewer just published, shown in place of the relay's copy
 * until the relay's copy catches up. `statusCreatedAt` is the `created_at`
 * of the published event, so a second drop on the same card outranks the
 * first (NIP-34 statuses are ordered by `created_at`) and the relay's copy
 * can be recognised as confirming the move.
 */
export type IssueStatusOverlay = {
  status: ProjectIssueStatus;
  statusCreatedAt: number;
};

export type IssueStatusOverlays = Readonly<Record<string, IssueStatusOverlay>>;

export function applyIssueStatusOverlay(
  issue: ProjectIssue,
  overlay: IssueStatusOverlay,
): ProjectIssue {
  return {
    ...issue,
    status: overlay.status,
    statusCreatedAt: overlay.statusCreatedAt,
  };
}

/**
 * True once the relay's copy of the issue carries a status at least as new as
 * the one the overlay stands in for — whether that is the viewer's own event
 * or a later one from somebody else, the relay is authoritative from here.
 */
export function issueConfirmsOverlay(
  issue: ProjectIssue,
  overlay: IssueStatusOverlay,
): boolean {
  return (
    issue.statusCreatedAt !== null &&
    issue.statusCreatedAt >= overlay.statusCreatedAt
  );
}

/**
 * Drops every overlay the given issues confirm. Returns the same object when
 * nothing changes so React state stays referentially stable.
 */
export function settleIssueStatusOverlays(
  overlays: IssueStatusOverlays,
  issues: readonly ProjectIssue[],
): IssueStatusOverlays {
  let next: Record<string, IssueStatusOverlay> | null = null;
  for (const issue of issues) {
    const overlay = overlays[issue.id];
    if (overlay && issueConfirmsOverlay(issue, overlay)) {
      next ??= { ...overlays };
      delete next[issue.id];
    }
  }
  return next ?? overlays;
}

/**
 * Optimistic status overlays for a board. A drop calls `begin` before the
 * publish starts and `rollBack` if it fails; success needs no call — the
 * overlay clears by itself once `issues` (the relay's copy) confirms it.
 *
 * Clearing on data rather than on "the refetch settled" matters: React Query
 * cancels an in-flight refetch when a second invalidation arrives, and the
 * first caller's await resolves at once with the cache still stale. A card
 * cleared on that signal would snap back to its old column for a moment.
 */
export function useIssueStatusOverlays(issues: readonly ProjectIssue[]) {
  const [overlays, setOverlays] = React.useState<IssueStatusOverlays>({});

  // Prune confirmed overlays. `apply` below already ignores them, so this is
  // housekeeping rather than what makes the card land.
  React.useEffect(() => {
    setOverlays((current) => settleIssueStatusOverlays(current, issues));
  }, [issues]);

  const apply = React.useCallback(
    (issue: ProjectIssue): ProjectIssue => {
      const overlay = overlays[issue.id];
      return overlay && !issueConfirmsOverlay(issue, overlay)
        ? applyIssueStatusOverlay(issue, overlay)
        : issue;
    },
    [overlays],
  );

  /**
   * Shows `status` on the card at once and returns the `created_at` the
   * publish must use, so the overlay and the event agree exactly.
   */
  const begin = React.useCallback(
    (
      issue: ProjectIssue,
      status: ProjectIssueStatus,
      nowSeconds = Math.floor(Date.now() / 1_000),
    ): number => {
      const statusCreatedAt = nextProjectIssueStatusCreatedAt(
        issue,
        nowSeconds,
      );
      setOverlays((current) => ({
        ...current,
        [issue.id]: { status, statusCreatedAt },
      }));
      return statusCreatedAt;
    },
    [],
  );

  const rollBack = React.useCallback(
    (issueId: string, statusCreatedAt: number) => {
      setOverlays((current) => {
        // A newer drag on the same card owns the overlay now.
        if (current[issueId]?.statusCreatedAt !== statusCreatedAt) {
          return current;
        }
        const rest = { ...current };
        delete rest[issueId];
        return rest;
      });
    },
    [],
  );

  return { apply, begin, rollBack };
}
