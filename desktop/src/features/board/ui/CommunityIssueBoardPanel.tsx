import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import {
  type ProjectIssue,
  useProjectsQuery,
  useProjectsWorkItemsQuery,
} from "@/features/projects/hooks";
import { useUpdateProjectIssueStatusMutation } from "@/features/projects/issueStatusMutations";
import type { IssueBoardDropStatus } from "@/features/projects/lib/issueBoardColumns";
import { projectsWithWorkItemRepositories } from "@/features/projects/projectWorkItems";
import {
  ProjectIssueBoard,
  type ProjectIssueBoardItem,
} from "@/features/projects/ui/ProjectIssueBoard";
import { ProjectIssueDetail } from "@/features/projects/ui/ProjectIssuesPanel";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import { ProjectsWorkItemsLoadNotice } from "@/features/projects/ui/ProjectsWorkItemsLoadNotice";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

const EMPTY_PROJECTS: never[] = [];

/**
 * Data + permissions wrapper for the community-wide kanban. Mirrors
 * `ProjectIssueBoardPanel`, but every card carries its own repository so a
 * drop publishes against the right one, and the owner check runs per card.
 */
export function CommunityIssueBoardPanel({
  onSelectedIssueIdChange,
  selectedIssueId,
}: {
  onSelectedIssueIdChange: (id: string | null) => void;
  selectedIssueId: string | null;
}) {
  const projectsQuery = useProjectsQuery();
  const workItemProjects = React.useMemo(
    () =>
      projectsWithWorkItemRepositories(projectsQuery.data ?? EMPTY_PROJECTS),
    [projectsQuery.data],
  );
  const workItemsQuery = useProjectsWorkItemsQuery(workItemProjects);
  const identityQuery = useIdentityQuery();
  const viewerPubkey = identityQuery.data?.pubkey;
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgentPubkeys = React.useMemo(
    () =>
      new Set(
        (managedAgentsQuery.data ?? []).map((agent) =>
          agent.pubkey.toLowerCase(),
        ),
      ),
    [managedAgentsQuery.data],
  );
  const { mutateAsync } = useUpdateProjectIssueStatusMutation();
  const queryClient = useQueryClient();
  // Show the move immediately, then drop the overlay once the refetch settles
  // (success) or the publish fails (rollback). It never outlives one write, so
  // a lagging relay cannot strand a card in a column it isn't in.
  const [pendingStatus, setPendingStatus] = React.useState<
    Record<string, ProjectIssue["status"]>
  >({});

  const clearPendingStatus = React.useCallback(
    (issueId: string, status: ProjectIssue["status"]) => {
      setPendingStatus((current) => {
        // A newer drag on the same card owns the overlay now.
        if (current[issueId] !== status) return current;
        const rest = { ...current };
        delete rest[issueId];
        return rest;
      });
    },
    [],
  );

  const items = React.useMemo<ProjectIssueBoardItem[]>(
    () =>
      (workItemsQuery.data?.issues.items ?? []).map(
        ({ issue, project, repository }) => {
          const pending = pendingStatus[issue.id];
          return {
            issue: pending ? { ...issue, status: pending } : issue,
            project: repository,
            projectName: project.name,
          };
        },
      ),
    [pendingStatus, workItemsQuery.data],
  );

  const issuePubkeys = React.useMemo(
    () => [
      ...new Set(
        items
          .flatMap(({ issue }) => [
            issue.author,
            ...issue.recipients,
            ...issue.assignees,
            ...issue.comments.map((comment) => comment.author),
          ])
          .map(normalizePubkey),
      ),
    ],
    [items],
  );
  const profilesQuery = useUsersBatchQuery(issuePubkeys, {
    enabled: issuePubkeys.length > 0,
  });
  const profiles = profilesQuery.data?.profiles;

  const isRepositoryOwner = React.useCallback(
    (item: ProjectIssueBoardItem) =>
      viewer === normalizePubkey(item.project.owner),
    [viewer],
  );
  const isManagedAgentOwner = React.useCallback(
    (item: ProjectIssueBoardItem) =>
      managedAgentPubkeys.has(item.project.owner.toLowerCase()),
    [managedAgentPubkeys],
  );

  const canMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem) =>
      Boolean(viewer) &&
      (viewer === normalizePubkey(item.issue.author) ||
        isRepositoryOwner(item) ||
        isManagedAgentOwner(item)),
    [isManagedAgentOwner, isRepositoryOwner, viewer],
  );

  const handleMoveIssue = React.useCallback(
    (item: ProjectIssueBoardItem, status: IssueBoardDropStatus) => {
      setPendingStatus((current) => ({ ...current, [item.issue.id]: status }));
      void mutateAsync({
        issue: item.issue,
        project: item.project,
        signAsManagedOwner:
          isManagedAgentOwner(item) && !isRepositoryOwner(item),
        status,
      })
        .then(async () => {
          // The mutation already asked for a refetch; awaiting the same key
          // joins that in-flight fetch and resolves when it settles.
          await queryClient.invalidateQueries({
            queryKey: ["projects", "work-items"],
          });
          clearPendingStatus(item.issue.id, status);
        })
        .catch((error: unknown) => {
          // Roll the card back to the column it came from.
          clearPendingStatus(item.issue.id, status);
          toast.error(
            error instanceof Error
              ? error.message
              : `Failed to move this task to ${status}.`,
          );
        });
    },
    [
      clearPendingStatus,
      isManagedAgentOwner,
      isRepositoryOwner,
      mutateAsync,
      queryClient,
    ],
  );

  const handleOpenIssue = React.useCallback(
    (item: ProjectIssueBoardItem) => onSelectedIssueIdChange(item.issue.id),
    [onSelectedIssueIdChange],
  );

  // A selected task that isn't in the community list (stale share link,
  // filtered away) falls through to the board rather than rendering nothing.
  const selectedItem =
    items.find(({ issue }) => issue.id === selectedIssueId) ?? null;

  if (projectsQuery.isLoading || workItemsQuery.isLoading) {
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

  const loadNotice = (
    <ProjectsWorkItemsLoadNotice
      error={workItemsQuery.error}
      failedSections={workItemsQuery.data?.issues.failedSections ?? []}
      isRetrying={workItemsQuery.isFetching && !workItemsQuery.isLoading}
      onRetry={() => void workItemsQuery.refetch()}
      subject="issues"
    />
  );

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {loadNotice}
        <ProjectPanelState
          description={
            workItemsQuery.error
              ? "Refresh the board and try again."
              : workItemProjects.length === 0
                ? "Attach a repository to a project to start tracking tasks."
                : "Tasks created in any project will appear here."
          }
          error={Boolean(workItemsQuery.error)}
          testId="community-board-empty"
          title={workItemsQuery.error ? "Could not load tasks" : "No tasks yet"}
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
        onMoveIssue={handleMoveIssue}
        onOpenIssue={handleOpenIssue}
        profiles={profiles}
      />
    </div>
  );
}
