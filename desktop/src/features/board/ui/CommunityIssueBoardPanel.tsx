import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import {
  type Project,
  useProjectsQuery,
  useProjectsWorkItemsQuery,
} from "@/features/projects/hooks";
import {
  type ProjectWorkItemSection,
  projectsWithWorkItemRepositories,
  projectsWorkItemsQueryKey,
} from "@/features/projects/projectWorkItems";
import { useIdentityQuery } from "@/shared/api/hooks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";
import {
  CommunityIssueBoardContent,
  type CommunityIssueWorkItem,
} from "./CommunityIssueBoardContent";

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_SECTIONS: ProjectWorkItemSection[] = [];
const EMPTY_WORK_ITEMS: CommunityIssueWorkItem[] = [];

/**
 * Query wiring for the community-wide kanban: every issue across every
 * repository-bearing project, the viewer's identity and managed agents, and
 * the profiles the cards show. Rendering, permissions and optimistic moves
 * live in `CommunityIssueBoardContent`.
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
  const queryClient = useQueryClient();
  // Leaving the board — route change or the Tasks tab — stops this panel's
  // own work-items fan, whose status and assignment pagination is
  // abort-aware. Exact key: other surfaces observe sibling keys under the
  // same prefix and must keep their fetches. Cached data stays either way.
  const workItemsQueryKey = React.useMemo(
    () => projectsWorkItemsQueryKey(workItemProjects),
    [workItemProjects],
  );
  const workItemsQueryKeyRef = React.useRef(workItemsQueryKey);
  workItemsQueryKeyRef.current = workItemsQueryKey;
  React.useEffect(
    () => () => {
      void queryClient.cancelQueries({
        exact: true,
        queryKey: workItemsQueryKeyRef.current,
      });
    },
    [queryClient],
  );

  const identityQuery = useIdentityQuery();
  const viewerPubkey = identityQuery.data?.pubkey;
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgentPubkeys = React.useMemo(
    () =>
      new Set(
        (managedAgentsQuery.data ?? []).map((agent) =>
          normalizePubkey(agent.pubkey),
        ),
      ),
    [managedAgentsQuery.data],
  );

  const workItems = workItemsQuery.data?.issues.items ?? EMPTY_WORK_ITEMS;
  const issuePubkeys = React.useMemo(
    () => [
      ...new Set(
        workItems
          .flatMap(({ issue }) => [
            issue.author,
            ...issue.recipients,
            ...issue.assignees,
            ...issue.comments.map((comment) => comment.author),
          ])
          .map(normalizePubkey),
      ),
    ],
    [workItems],
  );
  const profilesQuery = useUsersBatchQuery(issuePubkeys, {
    enabled: issuePubkeys.length > 0,
  });

  if (projectsQuery.isLoading || workItemsQuery.isLoading) {
    return <BuzzLoadingState label="Loading tasks" />;
  }

  return (
    <CommunityIssueBoardContent
      error={workItemsQuery.error}
      failedSections={
        workItemsQuery.data?.issues.failedSections ?? EMPTY_SECTIONS
      }
      hasRepositories={workItemProjects.length > 0}
      isRetrying={workItemsQuery.isFetching && !workItemsQuery.isLoading}
      managedAgentPubkeys={managedAgentPubkeys}
      onRetry={() => void workItemsQuery.refetch()}
      onSelectedIssueIdChange={onSelectedIssueIdChange}
      profiles={profilesQuery.data?.profiles}
      selectedIssueId={selectedIssueId}
      viewer={viewer}
      workItems={workItems}
    />
  );
}
