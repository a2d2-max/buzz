import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  getOpsCapabilities,
  loadDormantOpsModuleState,
  markDormantOpsModuleContractInvalid,
} from "./opsBridge";
import {
  subscribeOpsInvalidations,
  type OpsInvalidationPayload,
} from "./opsWatchManager";
import type {
  DormantOpsItemByModule,
  DormantOpsModuleName,
} from "./opsDormantContracts";
import {
  type CompleteOpsCollectionRequest,
  type CompleteOpsCollectionState,
  loadCompleteDormantOpsCollection,
} from "./opsPagedCollection";
import type { OpsBridgeCapabilitiesV1, OpsConnectionState } from "./types";

export function opsHomeCollectionRequests(): CompleteOpsCollectionRequest[] {
  return [
    { module: "work_items", scope: { sort: "last_activity_at_desc" } },
    { module: "sessions", scope: { sort: "last_activity_at_desc" } },
    { module: "decisions", scope: { sort: "updated_at_desc" } },
    { module: "approval_index", scope: { sort: "updated_at_desc" } },
    { module: "evidence", scope: { sort: "observed_at_desc" } },
    { module: "audit", scope: { sort: "observed_at_desc" } },
  ];
}

export function opsChecklistCollectionRequest(
  workItemId: string,
): CompleteOpsCollectionRequest<"checklist_items"> {
  return {
    module: "checklist_items",
    scope: { work_item: workItemId, sort: "order_asc_then_id" },
  };
}

export function opsCollectionQueryKey(
  request: CompleteOpsCollectionRequest,
  capabilityRevision: number,
  _invalidationRevision: number,
) {
  return [
    "ops",
    "complete",
    request.module,
    capabilityRevision,
    request.scope,
  ] as const;
}

const OPS_GLOBAL_CAPABILITIES_QUERY_KEY = [
  "ops",
  "global-capabilities",
] as const;

type CompleteCollectionQueryOptions<Module extends DormantOpsModuleName> = {
  capabilities?: OpsBridgeCapabilitiesV1;
  capabilityRevision: number;
  enabled?: boolean;
  invalidationRevision: number;
  load?: (
    request: CompleteOpsCollectionRequest<Module>,
    refreshCapabilities?: () => Promise<OpsBridgeCapabilitiesV1>,
  ) => Promise<CompleteOpsCollectionState<DormantOpsItemByModule[Module]>>;
  refreshCapabilities?: () => Promise<OpsBridgeCapabilitiesV1>;
  request: CompleteOpsCollectionRequest<Module>;
};

/** Query-key isolation prevents obsolete selection/capability results replacing current data. */
export function useOpsCompleteCollectionQuery<
  Module extends DormantOpsModuleName,
>({
  capabilities,
  capabilityRevision,
  enabled = true,
  invalidationRevision,
  load,
  refreshCapabilities,
  request,
}: CompleteCollectionQueryOptions<Module>) {
  return useQuery({
    enabled,
    queryFn: async () => {
      const result = load
        ? load(request, refreshCapabilities)
        : loadCompleteDormantOpsCollection(
            request,
            refreshCapabilities
              ? {
                  getCapabilities: refreshCapabilities,
                  loadModuleState: (pageRequest, nextCapabilities) =>
                    loadDormantOpsModuleState(pageRequest, nextCapabilities),
                  markContractInvalid: (module, nextCapabilities) =>
                    markDormantOpsModuleContractInvalid(
                      module,
                      nextCapabilities,
                    ),
                }
              : undefined,
            capabilities,
          );
      return await result;
    },
    queryKey: opsCollectionQueryKey(
      request,
      capabilityRevision,
      invalidationRevision,
    ),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const DISABLED_CHECKLIST_REQUEST =
  opsChecklistCollectionRequest("work:disabled");
const DISABLED_SEARCH_REQUEST = {
  module: "search",
  scope: {
    q: "disabled",
    sort: "rank_desc_then_observed_at_desc",
  },
} as const satisfies CompleteOpsCollectionRequest<"search">;

function moduleRevision(
  capabilities: OpsBridgeCapabilitiesV1 | undefined,
  module: DormantOpsModuleName,
): number | null {
  const capability = capabilities?.modules?.find(
    (candidate) => candidate.name === module,
  );
  if (!capability) return null;
  return capability.paged && capability.collection_revision !== undefined
    ? capability.collection_revision
    : -1;
}

function readyItems<Module extends DormantOpsModuleName>(
  state: CompleteOpsCollectionState<DormantOpsItemByModule[Module]> | undefined,
): DormantOpsItemByModule[Module][] {
  return state?.status === "ready" ? state.items : [];
}

export type OpsGlobalCollectionState<Module extends DormantOpsModuleName> =
  | CompleteOpsCollectionState<DormantOpsItemByModule[Module]>
  | { status: "disconnected" }
  | { status: "not_requested" }
  | { status: "pending" };

export type OpsGlobalCollectionStates = {
  [Module in DormantOpsModuleName]?: OpsGlobalCollectionState<Module>;
};

export function opsCollectionLifecycleState<
  Module extends DormantOpsModuleName,
>(
  revision: number | null,
  requested: boolean,
  state: CompleteOpsCollectionState<DormantOpsItemByModule[Module]> | undefined,
  error?: unknown,
): OpsGlobalCollectionState<Module> {
  if (!requested) return { status: "not_requested" };
  if (revision === null) return { status: "unavailable" };
  if (error) return { status: "disconnected" };
  return state ?? { status: "pending" };
}

export function opsGlobalBoundaryMode(
  connectionState: OpsConnectionState,
  pending: boolean,
  states: OpsGlobalCollectionStates,
): "connection" | "content" | "loading" {
  if (connectionState !== "ready" && connectionState !== "stale") {
    return "connection";
  }
  const hasReadyCollection = (
    Object.values(states) as Array<{ status: string } | undefined>
  ).some((state) => state?.status === "ready");
  return pending && !hasReadyCollection ? "loading" : "content";
}

export type UseOpsGlobalCollectionsOptions = {
  active: boolean;
  getCapabilities?: () => Promise<OpsBridgeCapabilitiesV1>;
  invalidationRevision?: number;
  loadCollection?: <Module extends DormantOpsModuleName>(
    request: CompleteOpsCollectionRequest<Module>,
    refreshCapabilities?: () => Promise<OpsBridgeCapabilitiesV1>,
  ) => Promise<CompleteOpsCollectionState<DormantOpsItemByModule[Module]>>;
  requestedModules?: DormantOpsModuleName[];
  searchRequest: CompleteOpsCollectionRequest<"search"> | null;
  selectedWorkId: string | null;
  subscribeInvalidations?: (
    listener: (payload: OpsInvalidationPayload) => void,
  ) => () => void;
};

/** Owns the eight read-only Task 3 collection queries for active Home/Work routes. */
export function useOpsGlobalCollections({
  active,
  getCapabilities: getCapabilitiesDependency = getOpsCapabilities,
  invalidationRevision = 0,
  loadCollection,
  requestedModules,
  searchRequest,
  selectedWorkId,
  subscribeInvalidations:
    subscribeInvalidationsDependency = subscribeOpsInvalidations,
}: UseOpsGlobalCollectionsOptions) {
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    enabled: active,
    queryFn: getCapabilitiesDependency,
    queryKey: OPS_GLOBAL_CAPABILITIES_QUERY_KEY,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const refreshCapabilities = React.useCallback(
    () =>
      queryClient.fetchQuery({
        queryFn: getCapabilitiesDependency,
        queryKey: OPS_GLOBAL_CAPABILITIES_QUERY_KEY,
        staleTime: 0,
      }),
    [getCapabilitiesDependency, queryClient],
  );
  const refetchGlobal = React.useCallback(async () => {
    const nextCapabilities = await refreshCapabilities();
    const revisions = new Map(
      nextCapabilities.modules?.map((module) => [
        module.name,
        module.paged ? module.collection_revision : undefined,
      ]) ?? [],
    );
    await queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "ops" &&
        queryKey[1] === "complete" &&
        revisions.get(queryKey[2] as string) === queryKey[3],
      refetchType: "active",
    });
  }, [queryClient, refreshCapabilities]);
  const invalidationVersion = React.useRef(0);
  const drainedInvalidationVersion = React.useRef(0);
  const invalidationDrain = React.useRef<Promise<void> | null>(null);
  React.useEffect(() => {
    if (!active) return;
    return subscribeInvalidationsDependency(() => {
      invalidationVersion.current += 1;
      if (invalidationDrain.current) return;
      const drain = (async () => {
        while (
          drainedInvalidationVersion.current < invalidationVersion.current
        ) {
          const target = invalidationVersion.current;
          try {
            await refetchGlobal();
          } catch {
            // React Query retains the classified capability error for the
            // route boundary; the next invalidation or explicit retry resumes.
          }
          drainedInvalidationVersion.current = target;
        }
      })();
      invalidationDrain.current = drain;
      void drain.finally(() => {
        if (invalidationDrain.current === drain) {
          invalidationDrain.current = null;
        }
      });
    });
  }, [active, refetchGlobal, subscribeInvalidationsDependency]);
  const revision = (module: DormantOpsModuleName) =>
    moduleRevision(capabilities.data, module);
  const requested = (module: DormantOpsModuleName) =>
    active &&
    (requestedModules === undefined || requestedModules.includes(module));
  const requests = opsHomeCollectionRequests();
  const workItems = useOpsCompleteCollectionQuery<"work_items">({
    capabilities: capabilities.data,
    capabilityRevision: revision("work_items") ?? -1,
    enabled: requested("work_items") && revision("work_items") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[0] as CompleteOpsCollectionRequest<"work_items">,
  });
  const sessions = useOpsCompleteCollectionQuery<"sessions">({
    capabilities: capabilities.data,
    capabilityRevision: revision("sessions") ?? -1,
    enabled: requested("sessions") && revision("sessions") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[1] as CompleteOpsCollectionRequest<"sessions">,
  });
  const decisions = useOpsCompleteCollectionQuery<"decisions">({
    capabilities: capabilities.data,
    capabilityRevision: revision("decisions") ?? -1,
    enabled: requested("decisions") && revision("decisions") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[2] as CompleteOpsCollectionRequest<"decisions">,
  });
  const approvals = useOpsCompleteCollectionQuery<"approval_index">({
    capabilities: capabilities.data,
    capabilityRevision: revision("approval_index") ?? -1,
    enabled: requested("approval_index") && revision("approval_index") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[3] as CompleteOpsCollectionRequest<"approval_index">,
  });
  const evidence = useOpsCompleteCollectionQuery<"evidence">({
    capabilities: capabilities.data,
    capabilityRevision: revision("evidence") ?? -1,
    enabled: requested("evidence") && revision("evidence") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[4] as CompleteOpsCollectionRequest<"evidence">,
  });
  const audit = useOpsCompleteCollectionQuery<"audit">({
    capabilities: capabilities.data,
    capabilityRevision: revision("audit") ?? -1,
    enabled: requested("audit") && revision("audit") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: requests[5] as CompleteOpsCollectionRequest<"audit">,
  });
  const checklistRequest = selectedWorkId
    ? opsChecklistCollectionRequest(selectedWorkId)
    : DISABLED_CHECKLIST_REQUEST;
  const checklist = useOpsCompleteCollectionQuery<"checklist_items">({
    capabilities: capabilities.data,
    capabilityRevision: revision("checklist_items") ?? -1,
    enabled:
      requested("checklist_items") &&
      selectedWorkId !== null &&
      revision("checklist_items") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: checklistRequest,
  });
  const search = useOpsCompleteCollectionQuery<"search">({
    capabilities: capabilities.data,
    capabilityRevision: revision("search") ?? -1,
    enabled:
      requested("search") &&
      searchRequest !== null &&
      revision("search") !== null,
    invalidationRevision,
    load: loadCollection,
    refreshCapabilities,
    request: searchRequest ?? DISABLED_SEARCH_REQUEST,
  });
  const states: OpsGlobalCollectionStates = {
    work_items: opsCollectionLifecycleState<"work_items">(
      revision("work_items"),
      requested("work_items"),
      workItems.data,
      workItems.error,
    ),
    sessions: opsCollectionLifecycleState<"sessions">(
      revision("sessions"),
      requested("sessions"),
      sessions.data,
      sessions.error,
    ),
    decisions: opsCollectionLifecycleState<"decisions">(
      revision("decisions"),
      requested("decisions"),
      decisions.data,
      decisions.error,
    ),
    approval_index: opsCollectionLifecycleState<"approval_index">(
      revision("approval_index"),
      requested("approval_index"),
      approvals.data,
      approvals.error,
    ),
    evidence: opsCollectionLifecycleState<"evidence">(
      revision("evidence"),
      requested("evidence"),
      evidence.data,
      evidence.error,
    ),
    audit: opsCollectionLifecycleState<"audit">(
      revision("audit"),
      requested("audit"),
      audit.data,
      audit.error,
    ),
    checklist_items: opsCollectionLifecycleState<"checklist_items">(
      revision("checklist_items"),
      requested("checklist_items") && selectedWorkId !== null,
      checklist.data,
      checklist.error,
    ),
    search: opsCollectionLifecycleState<"search">(
      revision("search"),
      requested("search") && searchRequest !== null,
      search.data,
      search.error,
    ),
  };
  const collectionQueries = [
    workItems,
    sessions,
    decisions,
    approvals,
    evidence,
    audit,
    checklist,
    search,
  ];
  const queryByModule: Record<
    DormantOpsModuleName,
    { refetch: () => Promise<unknown> }
  > = {
    work_items: workItems,
    sessions,
    checklist_items: checklist,
    decisions,
    approval_index: approvals,
    evidence,
    audit,
    search,
  };
  return {
    capabilities: capabilities.data,
    capabilityError: capabilities.error,
    collections: {
      workItems: readyItems<"work_items">(workItems.data),
      sessions: readyItems<"sessions">(sessions.data),
      checklist: readyItems<"checklist_items">(checklist.data),
      decisions: readyItems<"decisions">(decisions.data),
      approvals: readyItems<"approval_index">(approvals.data),
      evidence: readyItems<"evidence">(evidence.data),
      audit: readyItems<"audit">(audit.data),
      search: readyItems<"search">(search.data),
    },
    error:
      capabilities.error ?? collectionQueries.find(({ error }) => error)?.error,
    pending:
      active &&
      (capabilities.isPending ||
        collectionQueries.some(({ isPending, fetchStatus }) =>
          fetchStatus === "fetching" ? isPending : false,
        )),
    refreshed: collectionQueries.some(
      ({ data }) => data && "refreshed" in data && data.refreshed,
    ),
    refetch: refetchGlobal,
    refetchModule: (module: DormantOpsModuleName) =>
      queryByModule[module].refetch(),
    refreshCapabilities,
    states,
  };
}
