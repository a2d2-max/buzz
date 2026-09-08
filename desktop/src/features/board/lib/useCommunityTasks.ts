import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  fetchCommunityTaskEvents,
  publishCommunityTaskRevision,
  subscribeCommunityTaskEvents,
} from "./communityTaskRelay";

/** Keyed by relay so a community switch never shows the previous board. */
export function communityTasksQueryKey(relayUrl: string) {
  return ["community-tasks", relayUrl] as const;
}

function useActiveRelayUrl(): string {
  const { activeCommunity } = useCommunities();
  return activeCommunity?.relayUrl ?? "";
}

/**
 * The raw card events of the active community, every signer's included.
 * Consumers merge them with `mergeCommunityTaskEvents`; keeping events
 * rather than merged cards lets a live arrival replace exactly one
 * (signer, card) slot.
 */
export function useCommunityTaskEventsQuery() {
  const relayUrl = useActiveRelayUrl();
  return useQuery<RelayEvent[]>({
    queryKey: communityTasksQueryKey(relayUrl),
    queryFn: fetchCommunityTaskEvents,
    staleTime: 30_000,
  });
}

/**
 * Keeps the events query current: folds live arrivals into the cache and
 * refetches once the live subscription is armed (so nothing that landed
 * between the history fetch and that moment is missed) and again on every
 * reconnect. Mount once next to the board.
 */
export function useCommunityTasksLiveUpdates(): void {
  const queryClient = useQueryClient();
  const relayUrl = useActiveRelayUrl();

  React.useEffect(() => {
    const queryKey = communityTasksQueryKey(relayUrl);
    let disposed = false;
    let dispose: (() => void) | undefined;
    const invalidate = () => {
      if (disposed) return;
      void queryClient.invalidateQueries({ queryKey });
    };

    void subscribeCommunityTaskEvents((event) => {
      if (disposed) return;
      queryClient.setQueryData<RelayEvent[]>(queryKey, (current) =>
        // Before the history fetch has landed there is nothing to fold into;
        // the fetch itself will include this event.
        current === undefined
          ? undefined
          : upsertCommunityTaskEvent(current, event),
      );
    }, invalidate)
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
      });

    const unsubscribeReconnects = relayClient.subscribeToReconnects(invalidate);

    return () => {
      disposed = true;
      unsubscribeReconnects();
      dispose?.();
    };
  }, [queryClient, relayUrl]);
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
 * here — and folds the signed event into the events cache on success, so
 * the board reflects the write before the relay echoes it.
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
    onSuccess: (event) => {
      queryClient.setQueryData<RelayEvent[]>(
        communityTasksQueryKey(relayUrl),
        (current) =>
          current === undefined
            ? undefined
            : upsertCommunityTaskEvent(current, event),
      );
    },
  });
}
