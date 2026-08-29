import * as React from "react";

import { macTrafficLightClearance } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { isMacPlatform } from "@/shared/lib/platform";
import { useIsFullscreen } from "@/shared/lib/useIsFullscreen";
import { Button } from "@/shared/ui/button";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { OpsRoomScreen } from "./OpsRoomScreen";

type LocalOpsGuestAppProps = {
  onRestoreIdentity: () => void;
};

export function LocalOpsGuestApp({ onRestoreIdentity }: LocalOpsGuestAppProps) {
  const isFullscreen = useIsFullscreen();
  const clearsMacTrafficLights = isMacPlatform() && !isFullscreen;

  React.useLayoutEffect(() => {
    if (window.location.hash !== "#/ops") {
      window.location.hash = "/ops";
    }
  }, []);

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
      <OpsRoomScreen />
    </div>
  );
}
