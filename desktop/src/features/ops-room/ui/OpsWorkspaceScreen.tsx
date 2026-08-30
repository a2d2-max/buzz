import type * as React from "react";

import type { OpsNavigationPort, OpsRouteState } from "../opsRouteState";
import { OpsSecondaryNav } from "./OpsSecondaryNav";

export function OpsWorkspaceScreen({
  children,
  navigation,
  layout,
  showSectionNavigation = true,
  state,
}: {
  children: React.ReactNode;
  layout: "desktop" | "compact" | "mobile";
  navigation: OpsNavigationPort;
  showSectionNavigation?: boolean;
  state: OpsRouteState;
}) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${
        layout === "desktop" ? "flex-row" : "flex-col"
      }`}
    >
      {showSectionNavigation ? (
        <OpsSecondaryNav
          layout={layout}
          onOpenAgents={navigation.openAgents}
          onOpenProjects={navigation.openProjects}
          onOpenSettings={navigation.openSettings}
          onOpenWorkflows={navigation.openWorkflows}
          onSelect={(view) => navigation.pushOpsState({ ...state, view })}
          showLegacyNativeLinks={
            navigation.showLegacyNativeLinks ||
            Boolean(
              navigation.openAgents ||
                navigation.openProjects ||
                navigation.openSettings ||
                navigation.openWorkflows,
            )
          }
          view={state.view}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
