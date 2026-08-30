import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
  artifactRepresentationForKind,
  type OpsArtifactSelection,
} from "../artifactReader";
import {
  classifyOpsBridgeError,
  getOpsCapabilities,
  loadOpsPageWithStaleRestartResult,
  OpsBridgeContractError,
  OpsPageError,
  type OpsPageRequest,
  type OpsPageV1,
} from "../opsBridge";
import { mergeImmutableOpsPage } from "../opsPagedCollection";
import type {
  OpsBridgeCapabilitiesV1,
  OpsConnectionState as ConnectionState,
} from "../types";
import { OpsArtifactReader } from "./OpsArtifactReader";
import { OpsConnectionState } from "./OpsConnectionState";

type Artifact = {
  id: string;
  kind: string;
  status: string;
  title: string;
  version: number;
};
type ArtifactRow = Artifact & {
  representation: "preview" | "rendered" | null;
};
export type OpsArtifactsPageLoader = (cursor: string | null) => Promise<{
  items: Artifact[];
  next_cursor: string | null;
  restarted?: boolean;
}>;

export function artifactRows(items: readonly Artifact[]): ArtifactRow[] {
  return items.map((item) => ({
    ...item,
    representation: artifactRepresentationForKind(item.kind),
  }));
}

type OpsArtifactsPageDependencies = {
  getCapabilities: () => Promise<OpsBridgeCapabilitiesV1>;
  loadPage: (
    request: OpsPageRequest,
    expectedCollectionRevision: number,
  ) => Promise<{ page: OpsPageV1; restarted: boolean }>;
};

const DEFAULT_PAGE_DEPENDENCIES: OpsArtifactsPageDependencies = {
  getCapabilities: getOpsCapabilities,
  loadPage: loadOpsPageWithStaleRestartResult,
};

export async function loadArtifactsPage(
  cursor: string | null = null,
  dependencies: OpsArtifactsPageDependencies = DEFAULT_PAGE_DEPENDENCIES,
) {
  const capabilities = await dependencies.getCapabilities();
  const module = capabilities.modules?.find(
    (candidate) => candidate.name === "artifacts",
  );
  if (!module) throw new Error("artifacts_unavailable");
  if (
    !module.paged ||
    module.schema_version !== 1 ||
    module.collection_revision === undefined
  ) {
    throw new OpsBridgeContractError();
  }
  const result = await dependencies.loadPage(
    {
      module: "artifacts",
      cursor,
      scope: { work_item: null, representation: null, sort: "created_at_desc" },
    },
    module.collection_revision,
  );
  return { ...result.page, restarted: result.restarted } as {
    items: Artifact[];
    next_cursor: string | null;
    restarted: boolean;
  };
}

export function OpsArtifactsView({
  connectionState = "ready",
  disabled = false,
  moduleState = "ready",
  loadPage = loadArtifactsPage,
}: {
  connectionState?: ConnectionState;
  disabled?: boolean;
  moduleState?: "contract_invalid" | "ready" | "unavailable";
  loadPage?: OpsArtifactsPageLoader;
}) {
  const connectionReadable =
    connectionState === "ready" || connectionState === "stale";
  const moduleReadable = moduleState === "ready";
  const query = useQuery({
    queryKey: ["ops", "artifacts", "global"],
    queryFn: () => loadPage(null),
    enabled: connectionReadable && moduleReadable,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [pages, setPages] = React.useState<ArtifactRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pageError, setPageError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (query.data) {
      setPages(artifactRows(query.data.items));
      setNextCursor(query.data.next_cursor);
    }
  }, [query.data]);
  const rows = React.useMemo(() => mergeImmutableOpsPage([], pages), [pages]);
  const [selected, setSelected] = React.useState<OpsArtifactSelection | null>(
    null,
  );
  const trigger = React.useRef<HTMLButtonElement>(null);
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setPageError(null);
    try {
      const page = await loadPage(nextCursor);
      setPages((current) =>
        page.restarted
          ? artifactRows(page.items)
          : mergeImmutableOpsPage(current, artifactRows(page.items)),
      );
      setNextCursor(page.next_cursor);
    } catch (error) {
      setPageError(error);
    } finally {
      setLoadingMore(false);
    }
  };
  const retryArtifacts = () =>
    pageError ? void loadMore() : void query.refetch();
  if (!connectionReadable) {
    return (
      <OpsConnectionState
        onRetry={() => void query.refetch()}
        state={connectionState}
      />
    );
  }
  if (moduleState === "contract_invalid") {
    return (
      <div className="p-4 text-sm text-muted-foreground" role="status">
        Artifacts contract is invalid.
      </div>
    );
  }
  if (moduleState === "unavailable") {
    return (
      <div className="p-4 text-sm text-muted-foreground" role="status">
        Artifacts are unavailable.
      </div>
    );
  }
  const connectionBanner = (
    <OpsConnectionState
      onRetry={() => void query.refetch()}
      state={connectionState}
    />
  );
  if (query.isPending)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {connectionBanner}
        <div className="p-4 text-sm text-muted-foreground" role="status">
          Loading artifacts…
        </div>
      </div>
    );
  const effectiveError = query.error ?? pageError;
  if (effectiveError) {
    if (
      effectiveError instanceof OpsPageError &&
      effectiveError.code === "stale_cursor"
    ) {
      return (
        <div
          className="flex min-h-56 flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground"
          role="status"
        >
          <p>Artifacts changed again while refreshing. Try again.</p>
          <button
            className="min-h-11 rounded-lg border border-border px-3 text-sm"
            data-ops-interactive
            onClick={retryArtifacts}
            type="button"
          >
            Retry artifacts
          </button>
        </div>
      );
    }
    if (
      effectiveError instanceof OpsPageError &&
      effectiveError.code === "invalid_cursor"
    ) {
      return (
        <OpsConnectionState onRetry={retryArtifacts} state="contract_invalid" />
      );
    }
    if (
      effectiveError instanceof Error &&
      effectiveError.message === "artifacts_unavailable"
    ) {
      return (
        <div className="p-4 text-sm text-muted-foreground" role="status">
          Artifacts are unavailable.
        </div>
      );
    }
    return (
      <OpsConnectionState
        onRetry={retryArtifacts}
        state={classifyOpsBridgeError(effectiveError)}
      />
    );
  }
  if (rows.length === 0)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {connectionBanner}
        <div className="p-4 text-sm text-muted-foreground">
          No verified artifacts are available.
        </div>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {connectionBanner}
      <section
        className="min-h-0 min-w-0 flex-1 overflow-auto p-3"
        data-testid="ops-artifacts-view"
      >
        <h1 className="mb-3 text-lg font-semibold">Artifacts</h1>
        {disabled ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Read-only safe mode is active.
          </p>
        ) : null}
        <ul className="space-y-2">
          {rows.map((artifact) => (
            <li
              key={`${artifact.id}:${artifact.version}:${artifact.representation ?? "unsupported"}`}
            >
              {artifact.representation ? (
                <button
                  className="flex min-h-11 w-full items-center justify-between rounded-lg border border-border p-3 text-left hover:bg-muted"
                  data-ops-interactive
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    setSelected({
                      ...artifact,
                      representation: artifact.representation ?? "preview",
                    });
                  }}
                  type="button"
                >
                  <span className="min-w-0 truncate text-sm font-medium">
                    {artifact.title}
                  </span>
                  <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                    v{artifact.version} · {artifact.status}
                  </span>
                </button>
              ) : (
                <div className="rounded-lg border border-border p-3">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {artifact.title}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {artifact.kind} · native preview unavailable
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
        {nextCursor ? (
          <button
            className="mt-3 min-h-11 rounded-lg border border-border px-3 text-sm"
            data-ops-interactive
            disabled={loadingMore}
            onClick={() => void loadMore()}
            type="button"
          >
            {loadingMore ? "Loading more…" : "Load more"}
          </button>
        ) : null}
        {selected ? (
          <OpsArtifactReader
            artifact={selected}
            onClose={() => setSelected(null)}
            returnFocus={trigger.current}
          />
        ) : null}
      </section>
    </div>
  );
}
