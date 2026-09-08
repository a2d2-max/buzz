import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const DocsScreen = React.lazy(async () => {
  const module = await import("@/features/docs/ui/DocsScreen");
  return { default: module.DocsScreen };
});

export const Route = createFileRoute("/docs")({
  component: DocsRouteComponent,
});

function DocsRouteComponent() {
  usePreviewFeatureWarning("docs");
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="docs" />}>
      <DocsScreen />
    </React.Suspense>
  );
}
