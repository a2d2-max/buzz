import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import * as React from "react";

import {
  type BoardTab,
  DEFAULT_BOARD_TAB,
  parseBoardTab,
} from "@/features/board/boardTabs";
import { PROJECT_TAB_TRIGGER_CLASS } from "@/features/projects/ui/ProjectWorkspaceTabList";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { useHistorySearchState } from "@/shared/hooks/useHistorySearchState";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { CommunityIssueBoardPanel } from "./CommunityIssueBoardPanel";

const BOARD_SEARCH_KEYS = ["issue", "tab"] as const;

/**
 * Community-wide board: every issue from every project on one kanban, plus
 * a placeholder for a future tasks surface. Tab and open issue live in the
 * URL so back/forward and reloads restore them.
 */
export function BoardScreen() {
  const queryClient = useQueryClient();
  const { applyPatch, values } = useHistorySearchState(BOARD_SEARCH_KEYS);
  const tab = parseBoardTab(values.tab) ?? DEFAULT_BOARD_TAB;
  const selectedIssueId = values.issue;

  React.useEffect(() => {
    return () => {
      // Leaving the surface: stop the work-items fan, whose assignment
      // pagination is abort-aware. Cached data stays for the next visit.
      void queryClient.cancelQueries({ queryKey: ["projects", "work-items"] });
    };
  }, [queryClient]);

  const handleTabChange = React.useCallback(
    (value: string) => {
      const next = parseBoardTab(value) ?? DEFAULT_BOARD_TAB;
      applyPatch({
        issue: null,
        tab: next === DEFAULT_BOARD_TAB ? null : next,
      });
    },
    [applyPatch],
  );

  const handleSelectedIssueIdChange = React.useCallback(
    (id: string | null) => applyPatch({ issue: id }),
    [applyPatch],
  );

  return (
    <Tabs
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onValueChange={handleTabChange}
      value={tab satisfies BoardTab}
    >
      <TopChromeInsetHeader flush>
        <div className="flex min-h-9 items-center gap-2 px-4 py-2">
          {selectedIssueId ? (
            <Button
              aria-label="Back to board"
              className="h-7 w-7 p-0"
              data-testid="community-board-back"
              onClick={() => handleSelectedIssueIdChange(null)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <span className="text-sm font-semibold">Board</span>
          <TabsList className="ml-2 h-7 gap-1.5 bg-transparent p-0">
            <TabsTrigger
              className={PROJECT_TAB_TRIGGER_CLASS}
              data-testid="community-board-tab-issues"
              value="issues"
            >
              Issues
            </TabsTrigger>
            <TabsTrigger
              className={PROJECT_TAB_TRIGGER_CLASS}
              data-testid="community-board-tab-tasks"
              value="tasks"
            >
              Tasks
            </TabsTrigger>
          </TabsList>
        </div>
      </TopChromeInsetHeader>
      <TabsContent
        className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        value="issues"
      >
        <CommunityIssueBoardPanel
          onSelectedIssueIdChange={handleSelectedIssueIdChange}
          selectedIssueId={selectedIssueId}
        />
      </TabsContent>
      <TabsContent
        className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        value="tasks"
      >
        <ProjectPanelState
          description="A community-wide task board is on the way."
          panel={false}
          testId="community-board-tasks-placeholder"
          title="Coming soon"
        />
      </TabsContent>
    </Tabs>
  );
}
