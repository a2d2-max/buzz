import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const DatabasesScreen = React.lazy(async () => {
  const module = await import("@/features/databases/ui/DatabasesScreen");
  return { default: module.DatabasesScreen };
});

export const Route = createFileRoute("/databases/$databaseId")({
  component: DatabaseRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    view:
      typeof search.view === "string" && search.view.length <= 128
        ? search.view
        : undefined,
  }),
});

function DatabaseRouteComponent() {
  usePreviewFeatureWarning("databases");
  const { databaseId } = Route.useParams();
  const { view } = Route.useSearch();
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="databases" />}>
      <DatabasesScreen databaseId={databaseId} viewId={view} />
    </React.Suspense>
  );
}
