import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { type BoardTab, parseBoardTab } from "@/features/board/boardTabs";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const BoardScreen = React.lazy(async () => {
  const module = await import("@/features/board/ui/BoardScreen");
  return { default: module.BoardScreen };
});

type BoardRouteSearch = {
  issue?: string;
  tab?: BoardTab;
};

function validateBoardSearch(
  search: Record<string, unknown>,
): BoardRouteSearch {
  return {
    issue:
      typeof search.issue === "string" && search.issue.length > 0
        ? search.issue
        : undefined,
    tab: parseBoardTab(search.tab) ?? undefined,
  };
}

export const Route = createFileRoute("/board")({
  validateSearch: validateBoardSearch,
  component: BoardRouteComponent,
});

function BoardRouteComponent() {
  // The board publishes NIP-34 status events for project tasks, so it sits
  // behind the same preview gate as the Projects surface it writes to.
  usePreviewFeatureWarning("projects");
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="board" />}
    >
      <BoardScreen />
    </React.Suspense>
  );
}
