import {
  type QueryClient,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import {
  type CommunityTaskContent,
  nextMonotonicSeconds,
} from "./communityTaskCodec";
import { upsertCommunityTaskEvent } from "./communityTaskMerge";
import {
  fetchCommunityTaskCardEvents,
  fetchCommunityTaskEvents,
  publishCommunityTaskRevision,
  subscribeCommunityTaskEvents,
} from "./communityTaskRelay";

/** Keyed by relay so a community switch never shows the previous board. */
export function communityTasksQueryKey(relayUrl: string) {
  return ["community-tasks", relayUrl] as const;
}

export type CommunityTasksQueryKey = ReturnType<typeof communityTasksQueryKey>;

function useActiveRelayUrl(): string {
  const { activeCommunity } = useCommunities();
  return activeCommunity?.relayUrl ?? "";
}

/**
 * If the relay has not answered the live REQ by then, start history anyway.
 * The fetch waits on the same connection, so nothing is lost by trying —
 * only the "no gap" guarantee, which a reconnect refetch restores.
 */
export const COMMUNITY_TASKS_LIVE_FALLBACK_MS = 3_000;

type LiveState = "pending" | "armed" | "degraded";

function foldEvents(
  queryClient: QueryClient,
  queryKey: CommunityTasksQueryKey,
  incoming: readonly RelayEvent[],
): void {
  queryClient.setQueryData<RelayEvent[]>(queryKey, (current) => {
    // Nothing to fold into before history has landed; the history fetch,
    // which follows the live subscription, returns these rows itself.
    if (current === undefined) return undefined;
    let next = current;
    for (const event of incoming) next = upsertCommunityTaskEvent(next, event);
    return next;
  });
}

/**
 * The active community's card events, kept live. Consumers merge them with
 * `mergeCommunityTaskEvents`; keeping events rather than merged cards lets a
 * live arrival replace exactly one (signer, card) slot.
 *
 * Startup order matters. The live subscription is opened FIRST and history
 * is fetched only once it is armed (or has failed, or has gone quiet for
 * `COMMUNITY_TASKS_LIVE_FALLBACK_MS`). Fetching first would leave a gap
 * between the history EOSE and the live REQ registering, and closing that
 * gap by refetching on ready would walk the community's kind:30078 rows
 * twice on every mount. Reconnects still refetch: a live subscription with
 * `limit: 0` does not replay what was published while the socket was down.
 */
export function useCommunityTasks(): {
  query: UseQueryResult<RelayEvent[]>;
  queryKey: CommunityTasksQueryKey;
} {
  const queryClient = useQueryClient();
  const relayUrl = useActiveRelayUrl();
  const queryKey = React.useMemo(
    () => communityTasksQueryKey(relayUrl),
    [relayUrl],
  );
  const [liveState, setLiveState] = React.useState<LiveState>("pending");

  React.useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    setLiveState("pending");
    const invalidate = () => {
      if (disposed) return;
      void queryClient.invalidateQueries({ queryKey });
    };
    const fallback = globalThis.setTimeout(() => {
      if (disposed) return;
      setLiveState((state) => (state === "pending" ? "degraded" : state));
    }, COMMUNITY_TASKS_LIVE_FALLBACK_MS);

    void subscribeCommunityTaskEvents(
      (event) => {
        if (!disposed) foldEvents(queryClient, queryKey, [event]);
      },
      () => {
        if (!disposed) setLiveState("armed");
      },
    )
      .then((unsubscribe) => {
        if (disposed) {
          void unsubscribe();
        } else {
          dispose = () => {
            void unsubscribe();
          };
        }
      })
      .catch((error: unknown) => {
        console.error("[communityTasks] live subscription failed", error);
        if (!disposed) setLiveState("degraded");
      });

    const unsubscribeReconnects = relayClient.subscribeToReconnects(invalidate);

    return () => {
      disposed = true;
      globalThis.clearTimeout(fallback);
      unsubscribeReconnects();
      dispose?.();
    };
  }, [queryClient, queryKey]);

  const query = useQuery<RelayEvent[]>({
    queryKey,
    queryFn: fetchCommunityTaskEvents,
    enabled: liveState !== "pending",
    staleTime: 30_000,
  });
  return { query, queryKey };
}

export type SaveCommunityTaskInput = {
  id: string;
  content: CommunityTaskContent;
  /**
   * The newest `created_at` the signer themselves used for this card, so
   * the replacement published here sorts after it even from a lagging
   * clock. The relay compares only against the same signer's previous event.
   */
  previousEventCreatedAt?: number;
};

/**
 * Publishes one revision — create, edit, move, or tombstone all go through
 * here. On success the signed event is folded into the events cache at
 * once, then the card is reconciled against what the relay actually holds
 * for it (one cheap `#d` query, every signer included), so by the time
 * `mutateAsync` resolves the cache reflects the relay and not just our own
 * write. A failed reconcile is logged, not surfaced: the write itself
 * succeeded, and the next live event or reconnect refetch catches up.
 */
export function useSaveCommunityTaskMutation() {
  const queryClient = useQueryClient();
  const relayUrl = useActiveRelayUrl();

  return useMutation({
    mutationFn: ({
      content,
      id,
      previousEventCreatedAt,
    }: SaveCommunityTaskInput) =>
      publishCommunityTaskRevision({
        content,
        createdAt: nextMonotonicSeconds(
          Date.now() / 1_000,
          previousEventCreatedAt,
        ),
        id,
      }),
    onSuccess: async (event, { id }) => {
      const queryKey = communityTasksQueryKey(relayUrl);
      foldEvents(queryClient, queryKey, [event]);
      try {
        foldEvents(
          queryClient,
          queryKey,
          await fetchCommunityTaskCardEvents(id),
        );
      } catch (error) {
        console.warn("[communityTasks] reconcile after save failed", error);
      }
    },
  });
}
