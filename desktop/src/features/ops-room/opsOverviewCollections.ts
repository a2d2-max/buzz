import { useQuery } from "@tanstack/react-query";
import {
  getOpsCapabilities,
  getOpsPage,
  markOpsPagedModuleContractInvalid,
  OpsBridgeContractError,
  OpsPageError,
  type OpsPageRequest,
  type OpsPageV1,
} from "./opsBridge";
import type { OpsBridgeCapabilitiesV1, OpsModuleData } from "./types";

export type OpsOverviewModule = "repositories" | "research";
export type OpsOverviewRequest<Module extends OpsOverviewModule> = Omit<
  Extract<OpsPageRequest, { module: Module }>,
  "cursor" | "page_size"
>;
type OpsOverviewItem<Module extends OpsOverviewModule> =
  OpsModuleData[Module][number];

export type OpsOverviewCollectionState<T> =
  | { status: "unavailable" }
  | { status: "contract_invalid" }
  | { status: "retry_required"; refreshed: true }
  | {
      status: "ready";
      items: T[];
      revision: number;
      refreshed: boolean;
    };

type OpsOverviewDependencies = {
  getCapabilities: () => Promise<OpsBridgeCapabilitiesV1>;
  getPage: (
    request: OpsPageRequest,
    expectedRevision: number,
  ) => Promise<OpsPageV1>;
  markContractInvalid: (
    module: OpsOverviewModule,
    capabilities: OpsBridgeCapabilitiesV1,
  ) => void;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 32;

function advertisedRevision(
  module: OpsOverviewModule,
  capabilities: OpsBridgeCapabilitiesV1,
): number | null | "invalid" {
  const capability = capabilities.modules?.find(
    (candidate) => candidate.name === module,
  );
  if (!capability) return null;
  if (
    !capability.paged ||
    capability.schema_version !== 1 ||
    capability.collection_revision === undefined
  ) {
    return "invalid";
  }
  return capability.collection_revision;
}

export function opsOverviewCollectionQueryKey<Module extends OpsOverviewModule>(
  request: OpsOverviewRequest<Module>,
  revision: number,
) {
  return ["ops", "overview", request.module, revision, request.scope] as const;
}

export async function loadCompleteOpsOverviewCollection<
  Module extends OpsOverviewModule,
>(
  request: OpsOverviewRequest<Module>,
  dependencies: OpsOverviewDependencies,
  initialCapabilities?: OpsBridgeCapabilitiesV1,
): Promise<OpsOverviewCollectionState<OpsOverviewItem<Module>>> {
  let capabilities =
    initialCapabilities ?? (await dependencies.getCapabilities());
  let refreshed = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = advertisedRevision(request.module, capabilities);
    if (revision === null) return { status: "unavailable" };
    if (revision === "invalid") {
      dependencies.markContractInvalid(request.module, capabilities);
      return { status: "contract_invalid" };
    }

    const items: OpsOverviewItem<Module>[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    try {
      do {
        if (pageCount >= MAX_PAGES) {
          dependencies.markContractInvalid(request.module, capabilities);
          return { status: "contract_invalid" };
        }
        const page = await dependencies.getPage(
          { ...request, cursor, page_size: PAGE_SIZE } as OpsPageRequest,
          revision,
        );
        pageCount += 1;
        if (page.items.length > PAGE_SIZE) {
          dependencies.markContractInvalid(request.module, capabilities);
          return { status: "contract_invalid" };
        }
        for (const item of page.items as OpsOverviewItem<Module>[]) {
          if (ids.has(item.id)) {
            dependencies.markContractInvalid(request.module, capabilities);
            return { status: "contract_invalid" };
          }
          ids.add(item.id);
          items.push(item);
        }
        if (page.next_cursor !== null) {
          if (cursors.has(page.next_cursor)) {
            dependencies.markContractInvalid(request.module, capabilities);
            return { status: "contract_invalid" };
          }
          cursors.add(page.next_cursor);
        }
        cursor = page.next_cursor;
      } while (cursor !== null);
      return { status: "ready", items, revision, refreshed };
    } catch (error) {
      if (error instanceof OpsPageError && error.code === "stale_cursor") {
        if (attempt === 1) return { status: "retry_required", refreshed: true };
        capabilities = await dependencies.getCapabilities();
        refreshed = true;
        continue;
      }
      if (error instanceof OpsPageError && error.code === "unavailable") {
        return { status: "unavailable" };
      }
      if (
        error instanceof OpsBridgeContractError ||
        (error instanceof OpsPageError && error.code === "invalid_cursor")
      ) {
        dependencies.markContractInvalid(request.module, capabilities);
        return { status: "contract_invalid" };
      }
      throw error;
    }
  }
  return { status: "retry_required", refreshed: true };
}

export type OpsOverviewCollectionLifecycle<Module extends OpsOverviewModule> =
  | OpsOverviewCollectionState<OpsOverviewItem<Module>>
  | { status: "disconnected" }
  | { status: "not_requested" }
  | { status: "pending" };

type UseOpsOverviewCollectionsOptions = {
  activeModules: OpsOverviewModule[];
  capabilities?: OpsBridgeCapabilitiesV1;
  loadCollection?: <Module extends OpsOverviewModule>(
    request: OpsOverviewRequest<Module>,
    capabilities: OpsBridgeCapabilitiesV1,
  ) => Promise<OpsOverviewCollectionState<OpsOverviewItem<Module>>>;
  refreshCapabilities?: () => Promise<OpsBridgeCapabilitiesV1>;
};

const RESEARCH_REQUEST = {
  module: "research",
  scope: { work_item: null, sort: "created_at_desc" },
} as const satisfies OpsOverviewRequest<"research">;
const REPOSITORIES_REQUEST = {
  module: "repositories",
  scope: { project: null, sort: "display_name_asc" },
} as const satisfies OpsOverviewRequest<"repositories">;

function moduleRevision(
  capabilities: OpsBridgeCapabilitiesV1 | undefined,
  module: OpsOverviewModule,
): number | null {
  const capability = capabilities?.modules?.find(
    (candidate) => candidate.name === module,
  );
  if (!capability) return null;
  return capability.paged && capability.collection_revision !== undefined
    ? capability.collection_revision
    : -1;
}

function lifecycle<Module extends OpsOverviewModule>(
  active: boolean,
  revision: number | null,
  state: OpsOverviewCollectionState<OpsOverviewItem<Module>> | undefined,
  error?: unknown,
): OpsOverviewCollectionLifecycle<Module> {
  if (!active) return { status: "not_requested" };
  if (revision === null) return { status: "unavailable" };
  if (error) return { status: "disconnected" };
  return state ?? { status: "pending" };
}

/** Keeps legacy signed overview pages revision-keyed without inventing Task 5 shapes. */
export function useOpsOverviewCollections({
  activeModules,
  capabilities,
  loadCollection,
  refreshCapabilities = getOpsCapabilities,
}: UseOpsOverviewCollectionsOptions) {
  const active = (module: OpsOverviewModule) => activeModules.includes(module);
  const load = async <Module extends OpsOverviewModule>(
    request: OpsOverviewRequest<Module>,
  ): Promise<OpsOverviewCollectionState<OpsOverviewItem<Module>>> => {
    if (!capabilities) return { status: "unavailable" } as const;
    if (loadCollection) return loadCollection(request, capabilities);
    return loadCompleteOpsOverviewCollection(
      request,
      {
        getCapabilities: refreshCapabilities,
        getPage: (pageRequest, revision) => getOpsPage(pageRequest, revision),
        markContractInvalid: (module, nextCapabilities) =>
          markOpsPagedModuleContractInvalid(module, nextCapabilities),
      },
      capabilities,
    );
  };
  const researchRevision = moduleRevision(capabilities, "research");
  const repositoryRevision = moduleRevision(capabilities, "repositories");
  const research = useQuery({
    enabled: active("research") && researchRevision !== null,
    queryFn: () => load<"research">(RESEARCH_REQUEST),
    queryKey: opsOverviewCollectionQueryKey(
      RESEARCH_REQUEST,
      researchRevision ?? -1,
    ),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const repositories = useQuery({
    enabled: active("repositories") && repositoryRevision !== null,
    queryFn: () => load<"repositories">(REPOSITORIES_REQUEST),
    queryKey: opsOverviewCollectionQueryKey(
      REPOSITORIES_REQUEST,
      repositoryRevision ?? -1,
    ),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const refetch = async () => {
    const requests: Array<Promise<unknown>> = [];
    if (active("research")) requests.push(research.refetch());
    if (active("repositories")) requests.push(repositories.refetch());
    await Promise.all(requests);
  };
  return {
    research: lifecycle<"research">(
      active("research"),
      researchRevision,
      research.data,
      research.error,
    ),
    repositories: lifecycle<"repositories">(
      active("repositories"),
      repositoryRevision,
      repositories.data,
      repositories.error,
    ),
    error: research.error ?? repositories.error,
    pending:
      (active("research") &&
        research.isPending &&
        research.fetchStatus === "fetching") ||
      (active("repositories") &&
        repositories.isPending &&
        repositories.fetchStatus === "fetching"),
    refetch,
  };
}
