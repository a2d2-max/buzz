import * as React from "react";
import { toast } from "sonner";

import { useIsManagedAgent } from "@/features/agent-memory/hooks";
import {
  type ProjectIssue,
  type Repository as Project,
  useProjectIssuesQuery,
} from "@/features/projects/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { useUpdateProjectIssueStatusMutation } from "@/features/projects/issueStatusMutations";
import { useIssueStatusOverlays } from "@/features/projects/issueStatusOverlay";
import type { IssueBoardDropStatus } from "@/features/projects/lib/issueBoardColumns";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";
import {
  ProjectIssueBoard,
  type ProjectIssueBoardItem,
} from "./ProjectIssueBoard";
import { ProjectIssueDetail } from "./ProjectIssuesPanel";
import { ProjectPanelState } from "./ProjectPanelState";

const EMPTY_ISSUES: ProjectIssue[] = [];

/**
 * Data + permissions wrapper for the kanban board. `ProjectIssueBoard` stays
 * presentational so it can be rendered in tests without a query client.
 */
export function ProjectIssueBoardPanel({
  onSelectedIssueIdChange,
  profiles,
  project,
  selectedIssueId,
}: {
  onSelectedIssueIdChange: (id: string | null) => void;
  profiles?: UserProfileLookup;
  project: Project;
  selectedIssueId: string | null;
}) {
  const issuesQuery = useProjectIssuesQuery(project);
  const identityQuery = useIdentityQuery();
  const viewerPubkey = identityQuery.data?.pubkey;
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const isOwner = viewer === normalizePubkey(project.owner);
  const isManagedAgentOwner = useIsManagedAgent(project.owner) === true;
  const { mutateAsync } = useUpdateProjectIssueStatusMutation(project);
  const issues = issuesQuery.data ?? EMPTY_ISSUES;
  // Show the move immediately. The overlay clears once the refetch the
  // mutation triggers brings back a status at least as new as the one
  // published, or at once when the publish fails (rollback) — so a lagging
  // relay cannot strand a card in a column it isn't in.
  const { apply, begin, rollBack } = useIssueStatusOverlays(issues);

  const items = React.useMemo<ProjectIssueBoardItem[]>(
    () => issues.map((issue) => ({ issue: apply(issue), project })),
    [apply, issues, project],
  );

  const canMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem) =>
      Boolean(viewer) &&
      (viewer === normalizePubkey(item.issue.author) ||
        isOwner ||
        isManagedAgentOwner),
    [isManagedAgentOwner, isOwner, viewer],
  );

  const handleMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem, status: IssueBoardDropStatus) => {
      const createdAt = begin(item.issue, status);
      void mutateAsync({
        createdAt,
        issue: item.issue,
        signAsManagedOwner: isManagedAgentOwner && !isOwner,
        status,
      }).catch((error: unknown) => {
        // Roll the card back to the column it came from.
        rollBack(item.issue.id, createdAt);
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to move this task to ${status}.`,
        );
      });
    },
    [begin, isManagedAgentOwner, isOwner, mutateAsync, rollBack],
  );

  const handleOpenIssue = React.useCallback(
    (item: ProjectIssueBoardItem) => onSelectedIssueIdChange(item.issue.id),
    [onSelectedIssueIdChange],
  );

  // A selected task that isn't in this project's list (stale share link,
  // filtered away) falls through to the board rather than rendering nothing.
  const selectedItem =
    items.find(({ issue }) => issue.id === selectedIssueId) ?? null;

  if (issuesQuery.isLoading) {
    return <BuzzLoadingState label="Loading tasks" />;
  }

  if (selectedItem) {
    return (
      <ProjectIssueDetail
        issue={selectedItem.issue}
        profiles={profiles}
        project={selectedItem.project}
      />
    );
  }

  if (items.length === 0) {
    return (
      <ProjectPanelState
        description={
          issuesQuery.error
            ? "Refresh the project and try again."
            : "Tasks created for this repository will appear here."
        }
        error={Boolean(issuesQuery.error)}
        title={issuesQuery.error ? "Could not load tasks" : "No tasks yet"}
      />
    );
  }

  return (
    <ProjectIssueBoard
      canMoveIssue={canMoveIssue}
      items={items}
      onMoveIssue={handleMoveIssue}
      onOpenIssue={handleOpenIssue}
      profiles={profiles}
    />
  );
}
