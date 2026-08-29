import * as React from "react";

import { Button } from "@/shared/ui/button";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { OpsRoomScreen } from "./OpsRoomScreen";

type LocalOpsGuestAppProps = {
  onRestoreIdentity: () => void;
};

export function LocalOpsGuestApp({ onRestoreIdentity }: LocalOpsGuestAppProps) {
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
        className="flex min-w-0 flex-col gap-3 border-border/70 border-b bg-muted/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
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
