import * as React from "react";

import {
  type BoardTab,
  DEFAULT_BOARD_TAB,
  parseBoardTab,
} from "@/features/board/boardTabs";
import { PROJECT_TAB_TRIGGER_CLASS } from "@/features/projects/ui/ProjectWorkspaceTabList";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { useHistorySearchState } from "@/shared/hooks/useHistorySearchState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { CommunityIssueBoardPanel } from "./CommunityIssueBoardPanel";
import { CommunityTasksBoardPanel } from "./CommunityTasksBoardPanel";

const BOARD_SEARCH_KEYS = ["issue", "tab"] as const;

/**
 * Community-wide board: every issue from every project on one kanban, plus
 * a community task board for cards not tied to any repository. Tab and open issue live in the
 * URL so back/forward and reloads restore them.
 */
export function BoardScreen() {
  const { applyPatch, values } = useHistorySearchState(BOARD_SEARCH_KEYS);
  const tab = parseBoardTab(values.tab) ?? DEFAULT_BOARD_TAB;
  const selectedIssueId = values.issue;

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
        <CommunityTasksBoardPanel />
      </TabsContent>
    </Tabs>
  );
}
