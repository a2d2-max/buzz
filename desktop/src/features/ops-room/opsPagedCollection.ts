export type ImmutableOpsPageItem = {
  id: string;
  representation?: string | null;
  version: number;
};

function immutableKey(item: ImmutableOpsPageItem): string {
  return `${item.id}\u0000${item.version}\u0000${item.representation ?? ""}`;
}

export function mergeImmutableOpsPage<T extends ImmutableOpsPageItem>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(current.map(immutableKey));
  return [
    ...current,
    ...next.filter((item) => {
      const key = immutableKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export type CompleteOpsCollectionRequest<
  Module extends DormantOpsModuleName = DormantOpsModuleName,
> = Omit<
  Extract<DormantOpsPageRequest, { module: Module }>,
  "cursor" | "page_size"
>;

export type CompleteOpsCollectionState<T> =
  | { status: "unavailable" }
  | { status: "contract_invalid" }
  | { status: "retry_required"; refreshed: true }
  | {
      status: "ready";
      items: T[];
      revision: number;
      refreshed: boolean;
      authoritativeCapabilities?: OpsBridgeCapabilitiesV1;
    };

export type CompleteCollectionDependencies = {
  getCapabilities: () => Promise<OpsBridgeCapabilitiesV1>;
  loadModuleState: (
    request: DormantOpsPageRequest,
    capabilities: OpsBridgeCapabilitiesV1,
  ) => Promise<DormantOpsPageState<DormantOpsModuleName>>;
  markContractInvalid: (
    module: DormantOpsModuleName,
    capabilities: OpsBridgeCapabilitiesV1,
  ) => void;
};

const DEFAULT_COMPLETE_COLLECTION_DEPENDENCIES: CompleteCollectionDependencies =
  {
    getCapabilities: getOpsCapabilities,
    loadModuleState: (request, capabilities) =>
      loadDormantOpsModuleState(request, capabilities),
    markContractInvalid: markDormantOpsModuleContractInvalid,
  };

export const MAX_COMPLETE_COLLECTION_PAGES = 32;
const MAX_COMPLETE_COLLECTION_PAGE_ITEMS = 100;
export const MAX_COMPLETE_COLLECTION_ITEMS =
  MAX_COMPLETE_COLLECTION_PAGES * MAX_COMPLETE_COLLECTION_PAGE_ITEMS;

function advertisedRevision(
  module: DormantOpsModuleName,
  capabilities: OpsBridgeCapabilitiesV1,
): number | null | "invalid" {
  const capability = capabilities.modules?.find(
    (candidate) => candidate.name === module,
  );
  if (!capability) return null;
  if (
    capability.schema_version !== 1 ||
    !capability.paged ||
    capability.collection_revision === undefined
  ) {
    return "invalid";
  }
  return capability.collection_revision;
}

export function completeOpsCollectionKey(
  request: CompleteOpsCollectionRequest,
  revision: number,
) {
  return ["ops", "complete", request.module, revision, request.scope] as const;
}

/** Loads one frozen Task 3 collection completely with one whole-collection stale restart. */
export async function loadCompleteDormantOpsCollection<
  Module extends DormantOpsModuleName,
>(
  request: CompleteOpsCollectionRequest<Module>,
  dependencies: CompleteCollectionDependencies = DEFAULT_COMPLETE_COLLECTION_DEPENDENCIES,
  initialCapabilities?: OpsBridgeCapabilitiesV1,
): Promise<CompleteOpsCollectionState<DormantOpsItemByModule[Module]>> {
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

    const items: DormantOpsItemByModule[Module][] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    try {
      do {
        if (pageCount >= MAX_COMPLETE_COLLECTION_PAGES) {
          dependencies.markContractInvalid(request.module, capabilities);
          return { status: "contract_invalid" };
        }
        const state = await dependencies.loadModuleState(
          {
            ...request,
            cursor,
            page_size: MAX_COMPLETE_COLLECTION_PAGE_ITEMS,
          } as DormantOpsPageRequest,
          capabilities,
        );
        pageCount += 1;
        if (state.status === "unavailable") return { status: "unavailable" };
        if (state.status === "contract_invalid") {
          dependencies.markContractInvalid(request.module, capabilities);
          return { status: "contract_invalid" };
        }
        const pageItems = state.data.items as DormantOpsItemByModule[Module][];
        if (
          pageItems.length > MAX_COMPLETE_COLLECTION_PAGE_ITEMS ||
          items.length + pageItems.length > MAX_COMPLETE_COLLECTION_ITEMS
        ) {
          dependencies.markContractInvalid(request.module, capabilities);
          return { status: "contract_invalid" };
        }
        for (const candidate of pageItems) {
          if (ids.has(candidate.id)) {
            dependencies.markContractInvalid(request.module, capabilities);
            return { status: "contract_invalid" };
          }
          ids.add(candidate.id);
          items.push(candidate);
        }
        const nextCursor = state.data.next_cursor;
        if (nextCursor !== null) {
          if (cursors.has(nextCursor)) {
            dependencies.markContractInvalid(request.module, capabilities);
            return { status: "contract_invalid" };
          }
          cursors.add(nextCursor);
        }
        cursor = nextCursor;
      } while (cursor !== null);
      return {
        status: "ready",
        items,
        revision,
        refreshed,
        ...(refreshed
          ? {
              authoritativeCapabilities: capabilities,
            }
          : {}),
      };
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
      if (error instanceof OpsPageError && error.code === "invalid_cursor") {
        dependencies.markContractInvalid(request.module, capabilities);
        return { status: "contract_invalid" };
      }
      throw error;
    }
  }
  return { status: "retry_required", refreshed: true };
}
import type { OpsBridgeCapabilitiesV1 } from "./types";
import type {
  DormantOpsItemByModule,
  DormantOpsModuleName,
  DormantOpsPageRequest,
} from "./opsDormantContracts";
import {
  getOpsCapabilities,
  loadDormantOpsModuleState,
  markDormantOpsModuleContractInvalid,
  OpsPageError,
  type DormantOpsPageState,
} from "./opsBridge";
