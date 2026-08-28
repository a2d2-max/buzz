import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

const OpsRoomScreen = React.lazy(async () => {
  const module = await import("@/features/ops-room/ui/OpsRoomScreen");
  return { default: module.OpsRoomScreen };
});

export const Route = createFileRoute("/ops")({
  component: OpsRouteComponent,
});

function OpsRouteComponent() {
  usePreviewFeatureWarning("nativeOpsRoom");
  return (
    <React.Suspense
      fallback={<BuzzLoadingState fill label="Loading Ops Room" />}
    >
      <OpsRoomScreen />
    </React.Suspense>
  );
}
