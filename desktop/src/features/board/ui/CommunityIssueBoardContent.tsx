import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  canMoveCommunityIssue,
  communityIssueMoveSignsAsManagedOwner,
} from "@/features/board/communityIssuePermissions";
import type {
  Project,
  ProjectIssue,
  Repository,
} from "@/features/projects/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { useUpdateProjectIssueStatusMutation } from "@/features/projects/issueStatusMutations";
import { useIssueStatusOverlays } from "@/features/projects/issueStatusOverlay";
import type { IssueBoardDropStatus } from "@/features/projects/lib/issueBoardColumns";
import type { ProjectWorkItemSection } from "@/features/projects/projectWorkItems";
import {
  ProjectIssueBoard,
  type ProjectIssueBoardItem,
} from "@/features/projects/ui/ProjectIssueBoard";
import { ProjectIssueDetail } from "@/features/projects/ui/ProjectIssuesPanel";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import { ProjectsWorkItemsLoadNotice } from "@/features/projects/ui/ProjectsWorkItemsLoadNotice";
import { Button } from "@/shared/ui/button";

/** One issue row of the aggregate work-items fetch. */
export type CommunityIssueWorkItem = {
  issue: ProjectIssue;
  project: Project;
  repository: Repository;
};

export const STATUSES_UNAVAILABLE_MOVE_LOCK =
  "Task statuses could not be loaded — moving is paused until they are.";

export type CommunityIssueBoardContentProps = {
  error: unknown;
  failedSections: readonly ProjectWorkItemSection[];
  /** False while no project has a repository, so the empty state can say so. */
  hasRepositories: boolean;
  isRetrying: boolean;
  /** Normalised pubkeys of the viewer's managed agents. */
  managedAgentPubkeys: ReadonlySet<string>;
  onRetry: () => void;
  onSelectedIssueIdChange: (id: string | null) => void;
  profiles?: UserProfileLookup;
  selectedIssueId: string | null;
  /** Normalised viewer pubkey, or null while identity is unknown. */
  viewer: string | null;
  workItems: readonly CommunityIssueWorkItem[];
};

/**
 * Permissions + optimistic moves + rendering for the community-wide kanban,
 * fed by `CommunityIssueBoardPanel`. Every card carries its own repository
 * so a drop publishes against the right one, and the owner check runs per
 * card. Kept free of the community/query wiring so it can be rendered in
 * tests with plain props.
 */
export function CommunityIssueBoardContent({
  error,
  failedSections,
  hasRepositories,
  isRetrying,
  managedAgentPubkeys,
  onRetry,
  onSelectedIssueIdChange,
  profiles,
  selectedIssueId,
  viewer,
  workItems,
}: CommunityIssueBoardContentProps) {
  const { mutateAsync } = useUpdateProjectIssueStatusMutation();
  const issues = React.useMemo(
    () => workItems.map(({ issue }) => issue),
    [workItems],
  );
  // Show the move immediately. The overlay clears once the refetch the
  // mutation triggers brings back a status at least as new as the one
  // published, or at once when the publish fails (rollback).
  const { apply, begin, rollBack } = useIssueStatusOverlays(issues);
  const statusesUnavailable = failedSections.includes("statuses");

  const items = React.useMemo<ProjectIssueBoardItem[]>(
    () =>
      workItems.map(({ issue, project, repository }) => ({
        issue: apply(issue),
        project: repository,
        projectName: project.name,
      })),
    [apply, workItems],
  );

  const canMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem) =>
      canMoveCommunityIssue({
        item,
        managedAgentPubkeys,
        statusesUnavailable,
        viewer,
      }),
    [managedAgentPubkeys, statusesUnavailable, viewer],
  );

  const handleMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem, status: IssueBoardDropStatus) => {
      const createdAt = begin(item.issue, status);
      void mutateAsync({
        createdAt,
        issue: item.issue,
        project: item.project,
        signAsManagedOwner: communityIssueMoveSignsAsManagedOwner({
          item,
          managedAgentPubkeys,
          viewer,
        }),
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
    [begin, managedAgentPubkeys, mutateAsync, rollBack, viewer],
  );

  const handleOpenIssue = React.useCallback(
    (item: ProjectIssueBoardItem) => onSelectedIssueIdChange(item.issue.id),
    [onSelectedIssueIdChange],
  );

  // A selected task that isn't in the community list (stale share link,
  // filtered away) falls through to the board rather than rendering nothing.
  const selectedItem =
    items.find(({ issue }) => issue.id === selectedIssueId) ?? null;

  if (selectedItem) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <Button
            aria-label="Back to board"
            className="h-7 w-7 p-0"
            data-testid="community-board-back"
            onClick={() => onSelectedIssueIdChange(null)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {selectedItem.projectName}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProjectIssueDetail
            issue={selectedItem.issue}
            profiles={profiles}
            project={selectedItem.project}
          />
        </div>
      </div>
    );
  }

  const loadNotice = (
    <ProjectsWorkItemsLoadNotice
      error={error}
      failedSections={[...failedSections]}
      isRetrying={isRetrying}
      onRetry={onRetry}
      subject="issues"
    />
  );

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {loadNotice}
        <ProjectPanelState
          description={
            error
              ? "Refresh the board and try again."
              : hasRepositories
                ? "Tasks created in any project will appear here."
                : "Attach a repository to a project to start tracking tasks."
          }
          error={Boolean(error)}
          testId="community-board-empty"
          title={error ? "Could not load tasks" : "No tasks yet"}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {loadNotice}
      <ProjectIssueBoard
        canMoveIssue={canMoveIssue}
        items={items}
        moveLockedReason={
          statusesUnavailable ? STATUSES_UNAVAILABLE_MOVE_LOCK : undefined
        }
        onMoveIssue={handleMoveIssue}
        onOpenIssue={handleOpenIssue}
        profiles={profiles}
      />
    </div>
  );
}
