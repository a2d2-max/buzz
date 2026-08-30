import * as React from "react";

import { RAOU_PRODUCT } from "@/app/productBrand";
import { RAOU_THEME } from "@/app/raouDocumentTheme";
import { macTrafficLightClearance } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { getLocalWorkspaceId } from "@/shared/lib/localWorkspaceIdentity";
import { isMacPlatform } from "@/shared/lib/platform";
import { useIsFullscreen } from "@/shared/lib/useIsFullscreen";
import { Button } from "@/shared/ui/button";
import { RaouMark } from "@/shared/ui/RaouMark";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import {
  createHashOpsNavigationPort,
  normalizeHashOpsNavigation,
} from "../opsRouteState";
import { OpsRoomScreen } from "./OpsRoomScreen";

type LocalOpsGuestAppProps = { onRestoreIdentity?: () => void };

export function RaouWorkspaceApp() {
  const isFullscreen = useIsFullscreen();
  const clearsMacTrafficLights = isMacPlatform() && !isFullscreen;
  const navigation = React.useMemo(() => createHashOpsNavigationPort(), []);
  const workspaceId = React.useMemo(() => getLocalWorkspaceId(), []);

  React.useLayoutEffect(() => {
    normalizeHashOpsNavigation(navigation, window.location.hash);
  }, [navigation]);

  return (
    <div
      className="flex min-h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground"
      style={RAOU_THEME as React.CSSProperties}
    >
      <StartupWindowDragRegion />
      <header
        className={cn(
          "relative flex h-12 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-border border-b bg-[#161A1D] pr-4",
          clearsMacTrafficLights
            ? macTrafficLightClearance.withoutLeadingRail
            : "pl-4",
        )}
      >
        <RaouMark className="h-6 w-8 shrink-0 text-[#C8FF45]" />
        <span className="shrink-0 text-sm font-semibold tracking-[0.18em] text-[#D9E0D6]">
          {RAOU_PRODUCT.name}
        </span>
        <span className="h-4 w-px shrink-0 bg-[#262C30]" aria-hidden="true" />
        <span className="min-w-0 truncate text-xs text-[#D9E0D6]/70">
          {RAOU_PRODUCT.localWorkspaceLabel}
        </span>
        <span
          className="shrink-0 font-mono text-2xs tracking-[0.08em] text-[#F2C45C]"
          data-testid="raou-workspace-id"
        >
          {workspaceId.slice(0, 8)}
        </span>
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-[80px] right-[22%] h-px bg-[#C8FF45]"
        />
      </header>
      <OpsRoomScreen navigation={navigation} />
    </div>
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
