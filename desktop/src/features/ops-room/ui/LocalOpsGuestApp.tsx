import * as React from "react";

import { AppTopChrome } from "@/app/AppTopChrome";
import { AppTopChromePortal } from "@/app/AppTopChromePortal";
import { RAOU_THEME } from "@/app/raouDocumentTheme";
import { macTrafficLightClearance } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { getLocalWorkspaceId } from "@/shared/lib/localWorkspaceIdentity";
import { isMacPlatform } from "@/shared/lib/platform";
import { useIsFullscreen } from "@/shared/lib/useIsFullscreen";
import { useTauriWindowDrag } from "@/app/useTauriWindowDrag";
import { Button } from "@/shared/ui/button";
import { RaouMark } from "@/shared/ui/RaouMark";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar";
import {
  createHashOpsNavigationPort,
  normalizeHashOpsNavigation,
  type OpsRouteState,
} from "../opsRouteState";
import { OpsRoomScreen } from "./OpsRoomScreen";
import {
  RAOU_WORKSPACE_VIEW_LABELS,
  RaouWorkspaceSidebar,
} from "./RaouWorkspaceSidebar";

type LocalOpsGuestAppProps = { onRestoreIdentity?: () => void };

export function RaouWorkspaceApp() {
  useTauriWindowDrag();
  const navigation = React.useMemo(() => createHashOpsNavigationPort(), []);
  const workspaceId = React.useMemo(() => getLocalWorkspaceId(), []);
  const [routeState, setRouteState] = React.useState<OpsRouteState>(() =>
    navigation.readOpsState(),
  );

  React.useLayoutEffect(() => {
    normalizeHashOpsNavigation(navigation, window.location.hash);
  }, [navigation]);
  React.useEffect(() => {
    const sync = () => setRouteState(navigation.readOpsState());
    sync();
    return navigation.subscribe(sync);
  }, [navigation]);

  return (
    <SidebarProvider
      className="flex min-h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground"
      style={RAOU_THEME as React.CSSProperties}
    >
      <AppTopChrome
        canGoBack={window.history.length > 1}
        canGoForward={false}
        onGoBack={() => window.history.back()}
        onGoForward={() => window.history.forward()}
      />
      <AppTopChromePortal>
        <div className="flex min-w-0 flex-1 items-center justify-center px-3 text-xs font-medium text-sidebar-foreground/70">
          <RaouMark className="mr-2 h-4 w-5 shrink-0 text-primary md:hidden" />
          <span className="truncate">
            {RAOU_WORKSPACE_VIEW_LABELS[routeState.view]}
          </span>
        </div>
      </AppTopChromePortal>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <RaouWorkspaceSidebar
          onSelect={(view) => navigation.pushOpsState({ ...routeState, view })}
          state={routeState}
          workspaceId={workspaceId}
        />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden border-sidebar-border/40 border-l">
          <span className="sr-only" data-testid="raou-workspace-id">
            {workspaceId.slice(0, 8)}
          </span>
          <OpsRoomScreen
            navigation={navigation}
            showSectionNavigation={false}
          />
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

export function LocalOpsGuestApp({
  onRestoreIdentity = () => {},
}: LocalOpsGuestAppProps) {
  const isFullscreen = useIsFullscreen();
  const clearsMacTrafficLights = isMacPlatform() && !isFullscreen;
  const navigation = React.useMemo(
    () => ({
      ...createHashOpsNavigationPort(),
      showLegacyNativeLinks: true,
    }),
    [],
  );

  React.useLayoutEffect(() => {
    normalizeHashOpsNavigation(navigation, window.location.hash);
  }, [navigation]);

  return (
    <div className="flex min-h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <StartupWindowDragRegion />
      <aside
        aria-label="Local Ops mode"
        className={cn(
          "flex min-w-0 flex-col gap-3 border-border/70 border-b bg-muted/40 py-3 pr-5 sm:flex-row sm:items-center sm:justify-between",
          clearsMacTrafficLights
            ? macTrafficLightClearance.withoutLeadingRail
            : "pl-5",
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold">Local Ops mode</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Messaging, signed actions, and external actions are unavailable
            until you restore your identity.
          </p>
        </div>
        <Button
          className="min-h-11 shrink-0"
          onClick={onRestoreIdentity}
          type="button"
          variant="outline"
        >
          Restore identity
        </Button>
      </aside>
      <OpsRoomScreen navigation={navigation} />
    </div>
  );
}
