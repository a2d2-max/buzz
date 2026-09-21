import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const DatabasesScreen = React.lazy(async () => {
  const module = await import("@/features/databases/ui/DatabasesScreen");
  return { default: module.DatabasesScreen };
});

export const Route = createFileRoute("/databases")({
  component: DatabasesRouteComponent,
});

function DatabasesRouteComponent() {
  usePreviewFeatureWarning("databases");
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="databases" />}>
      <DatabasesScreen />
    </React.Suspense>
  );
}
