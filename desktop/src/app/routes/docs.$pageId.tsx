import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";
import { CommunityDatabasesProvider } from "@/features/databases/ui/CommunityDatabasesProvider";

const DocsScreen = React.lazy(async () => {
  const module = await import("@/features/docs/ui/DocsScreen");
  return { default: module.DocsScreen };
});

export const Route = createFileRoute("/docs/$pageId")({
  component: DocPageRouteComponent,
});

function DocPageRouteComponent() {
  usePreviewFeatureWarning("docs");
  const { pageId } = Route.useParams();
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="docs" />}>
      <CommunityDatabasesProvider>
        <DocsScreen pageId={pageId} />
      </CommunityDatabasesProvider>
    </React.Suspense>
  );
}
