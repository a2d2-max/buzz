import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  createRouterOpsNavigationPort,
  normalizeOpsNavigation,
  type OpsNavigationPort,
} from "@/features/ops-room/opsRouteState";
import { useLocalOpsGuestMode } from "@/features/onboarding/localOpsGuestMode";
import { usePreviewFeatureWarning } from "@/shared/features";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

const OpsRoomScreen = React.lazy(async () => {
  const module = await import("@/features/ops-room/ui/OpsRoomScreen");
  return { default: module.OpsRoomScreen };
});

export const Route = createFileRoute("/ops")({
  component: OpsRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    channel: typeof search.channel === "string" ? search.channel : undefined,
    thread: typeof search.thread === "string" ? search.thread : undefined,
    view: typeof search.view === "string" ? search.view : undefined,
  }),
});

function OpsRouteComponent() {
  const localOpsGuestMode = useLocalOpsGuestMode();
  usePreviewFeatureWarning("nativeOpsRoom", localOpsGuestMode);
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const navigation = React.useMemo<OpsNavigationPort>(
    () =>
      createRouterOpsNavigationPort({
        navigate,
        openAgents: () => void navigate({ to: "/agents" }),
        openProjects: () => void navigate({ to: "/projects" }),
        openSettings: () => void navigate({ to: "/settings" }),
        openWorkflows: () =>
          void navigate({
            search: { channel: undefined, pane: undefined, view: undefined },
            to: "/workflows",
          }),
        readSearch: () => search,
      }),
    [navigate, search],
  );
  React.useEffect(() => {
    normalizeOpsNavigation(navigation, search.view);
  }, [navigation, search.view]);
  return (
    <React.Suspense
      fallback={<BuzzLoadingState fill label="Loading Ops Room" />}
    >
      <OpsRoomScreen navigation={navigation} />
    </React.Suspense>
  );
}
