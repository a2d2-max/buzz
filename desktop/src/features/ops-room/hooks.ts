import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  classifyOpsBridgeError,
  acknowledgeOpsSync,
  getOpsCapabilities,
  hasInvalidOpsModule,
  loadOpsSnapshot,
  opsSnapshotQueryKey,
} from "./opsBridge";
import {
  ensureOpsWatchManager,
  completeOpsSync,
  type OpsInvalidationPayload,
  isOpsSyncCurrent,
  subscribeOpsInvalidations,
} from "./opsWatchManager";
import type {
  OpsBridgeSnapshotV1,
  OpsConnectionState,
  OpsSelection,
} from "./types";

const READY_PROBE_MS = 10_000;
const RECOVERY_POLL_MS = 2_000;
export { resetOpsWatchManager } from "./opsWatchManager";

export interface UseOpsSnapshotResult {
  state: OpsConnectionState;
  snapshot: OpsBridgeSnapshotV1 | null;
  error: unknown;
  mutationsDisabled: boolean;
  refetch: () => Promise<void>;
  watchState: "enabled" | "disabled_compatibility";
}

function currentWindowFocus(): boolean {
  if (typeof document === "undefined") return true;
  if (document.visibilityState !== "visible") return false;
  return typeof document.hasFocus !== "function" || document.hasFocus();
}

function useOpsWindowFocused(): boolean {
  const [focused, setFocused] = React.useState(currentWindowFocus);

  React.useEffect(() => {
    const update = () => setFocused(currentWindowFocus());
    const blur = () => setFocused(false);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return focused;
}

function lifecycleState(
  snapshot: OpsBridgeSnapshotV1 | null,
  pending: boolean,
  error: unknown,
  probeFailure: OpsConnectionState | null,
): OpsConnectionState {
  if (probeFailure) {
    if (probeFailure === "disconnected" && snapshot) return "stale";
    return probeFailure;
  }
  if (error) {
    const classified = classifyOpsBridgeError(error);
    if (classified === "disconnected" && snapshot) return "stale";
    return classified;
  }
  if (snapshot) return "ready";
  return pending ? "loading" : "disconnected";
}

export function opsMutationsDisabled(
  state: OpsConnectionState,
  snapshot: Pick<OpsBridgeSnapshotV1, "module_states"> | null,
): boolean {
  return state !== "ready" || (snapshot ? hasInvalidOpsModule(snapshot) : true);
}

export function useOpsSnapshot(selection: OpsSelection): UseOpsSnapshotResult {
  const queryClient = useQueryClient();
  const focused = useOpsWindowFocused();
  const normalizedSelection = React.useMemo(
    () => ({
      channel: selection.channel ?? null,
      thread: selection.thread ?? null,
      limit: selection.limit ?? 100,
    }),
    [selection.channel, selection.limit, selection.thread],
  );
  const queryKey = React.useMemo(
    () => opsSnapshotQueryKey(normalizedSelection),
    [normalizedSelection],
  );
  const queryKeyIdentity = JSON.stringify(queryKey);
  const lastGoodSnapshot = React.useRef<{
    queryKeyIdentity: string;
    snapshot: OpsBridgeSnapshotV1;
  } | null>(null);
  const [probeFailureRecord, setProbeFailureRecord] = React.useState<{
    queryKeyIdentity: string;
    state: OpsConnectionState;
  } | null>(null);
  const mounted = React.useRef(true);
  const invalidationVersion = React.useRef(0);
  const drainedInvalidationVersion = React.useRef(0);
  const pendingFullReload = React.useRef(false);
  const pendingSync = React.useRef<{
    generation: number;
    ticket: number;
  } | null>(null);
  const failedSyncRefetch = React.useRef<{
    generation: number;
    ticket: number;
  } | null>(null);
  const invalidationDrain = React.useRef<Promise<void> | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => loadOpsSnapshot(normalizedSelection),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (query.data) {
    lastGoodSnapshot.current = { queryKeyIdentity, snapshot: query.data };
  }
  const snapshot =
    query.data ??
    (lastGoodSnapshot.current?.queryKeyIdentity === queryKeyIdentity
      ? lastGoodSnapshot.current.snapshot
      : null);
  const probeFailure =
    probeFailureRecord?.queryKeyIdentity === queryKeyIdentity
      ? probeFailureRecord.state
      : null;
  const hasCanonicalSnapshot = snapshot !== null;
  const watchState =
    snapshot?.event_sequence === undefined
      ? "disabled_compatibility"
      : "enabled";
  const state = lifecycleState(
    snapshot,
    query.isPending,
    query.error,
    probeFailure,
  );

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!query.data) return;
    setProbeFailureRecord((failure) =>
      failure?.queryKeyIdentity === queryKeyIdentity ? null : failure,
    );
  }, [query.data, queryKeyIdentity]);

  React.useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (state === "ready") {
      const probe = async () => {
        try {
          await getOpsCapabilities();
          if (!cancelled) timer = setTimeout(probe, READY_PROBE_MS);
        } catch (error) {
          if (!cancelled) {
            setProbeFailureRecord({
              queryKeyIdentity,
              state: classifyOpsBridgeError(error),
            });
          }
        }
      };
      timer = setTimeout(probe, READY_PROBE_MS);
    } else if (state === "stale" || state === "disconnected") {
      const recover = async () => {
        const result = await query.refetch({ cancelRefetch: false });
        if (!cancelled && result.error) {
          const failure = classifyOpsBridgeError(result.error);
          setProbeFailureRecord({ queryKeyIdentity, state: failure });
          if (failure === "disconnected") {
            timer = setTimeout(recover, RECOVERY_POLL_MS);
          }
        } else if (!cancelled) {
          setProbeFailureRecord((failure) =>
            failure?.queryKeyIdentity === queryKeyIdentity ? null : failure,
          );
        }
      };
      timer = setTimeout(recover, RECOVERY_POLL_MS);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [focused, query.refetch, queryKeyIdentity, state]);

  const wasFocused = React.useRef(focused);
  React.useEffect(() => {
    const returnedToFocus = focused && !wasFocused.current;
    wasFocused.current = focused;
    if (!returnedToFocus) return;
    if (
      state === "not_configured" ||
      state === "version_mismatch" ||
      state === "contract_invalid"
    ) {
      return;
    }
    void query.refetch({ cancelRefetch: false });
  }, [focused, query.refetch, state]);

  const handleInvalidation = React.useCallback(
    (payload: OpsInvalidationPayload) => {
      invalidationVersion.current += 1;
      if (payload.full_reload === true) pendingFullReload.current = true;
      if (
        payload.sync_required === true &&
        Number.isSafeInteger(payload.connection_generation) &&
        Number.isSafeInteger(payload.sync_ticket)
      ) {
        pendingSync.current = {
          generation: payload.connection_generation ?? 0,
          ticket: payload.sync_ticket ?? 0,
        };
      }
      if (invalidationDrain.current) return;

      const drain = (async () => {
        while (
          drainedInvalidationVersion.current < invalidationVersion.current
        ) {
          const targetVersion = invalidationVersion.current;
          const fullReload = pendingFullReload.current;
          pendingFullReload.current = false;
          const sync = pendingSync.current;
          if (fullReload) {
            await queryClient.invalidateQueries({
              queryKey: ["ops"],
              refetchType: "none",
            });
          }
          const result = await query.refetch({ cancelRefetch: false });
          drainedInvalidationVersion.current = targetVersion;
          if (result.error) {
            if (
              sync &&
              pendingSync.current?.ticket === sync.ticket &&
              isOpsSyncCurrent(sync.generation, sync.ticket)
            ) {
              failedSyncRefetch.current = sync;
            }
            continue;
          }
          if (
            !sync ||
            invalidationVersion.current !== targetVersion ||
            pendingSync.current?.ticket !== sync.ticket ||
            !isOpsSyncCurrent(sync.generation, sync.ticket)
          ) {
            continue;
          }
          if (failedSyncRefetch.current?.ticket === sync.ticket) {
            failedSyncRefetch.current = null;
          }
          const appliedSequence = result.data?.event_sequence;
          if (appliedSequence === undefined) continue;
          try {
            const ack = await acknowledgeOpsSync(
              sync.generation,
              appliedSequence,
            );
            if (ack.accepted) {
              completeOpsSync(sync.generation, sync.ticket);
              if (pendingSync.current?.ticket === sync.ticket) {
                pendingSync.current = null;
              }
            }
          } catch (error) {
            setProbeFailureRecord({
              queryKeyIdentity,
              state: classifyOpsBridgeError(error),
            });
          }
        }
      })();
      invalidationDrain.current = drain;
      void drain.finally(() => {
        if (invalidationDrain.current === drain) {
          invalidationDrain.current = null;
        }
      });
    },
    [query.refetch, queryClient, queryKeyIdentity],
  );

  React.useEffect(() => {
    const sync = failedSyncRefetch.current;
    const recovered = query.data;
    if (!sync || !recovered) return;
    if (
      pendingSync.current?.ticket !== sync.ticket ||
      !isOpsSyncCurrent(sync.generation, sync.ticket)
    ) {
      failedSyncRefetch.current = null;
      return;
    }
    const appliedSequence = recovered.event_sequence;
    if (appliedSequence === undefined) return;
    failedSyncRefetch.current = null;
    void acknowledgeOpsSync(sync.generation, appliedSequence)
      .then((ack) => {
        if (
          ack.accepted &&
          pendingSync.current?.ticket === sync.ticket &&
          isOpsSyncCurrent(sync.generation, sync.ticket)
        ) {
          completeOpsSync(sync.generation, sync.ticket);
          pendingSync.current = null;
        }
      })
      .catch((error) => {
        if (!mounted.current) return;
        setProbeFailureRecord({
          queryKeyIdentity,
          state: classifyOpsBridgeError(error),
        });
      });
  }, [query.data, queryKeyIdentity]);

  React.useEffect(() => {
    if (!hasCanonicalSnapshot || watchState !== "enabled") return;
    return subscribeOpsInvalidations(handleInvalidation);
  }, [handleInvalidation, hasCanonicalSnapshot, watchState]);

  React.useEffect(() => {
    if (
      !hasCanonicalSnapshot ||
      state !== "ready" ||
      watchState !== "enabled"
    ) {
      return;
    }
    let disposed = false;
    void ensureOpsWatchManager().catch((error) => {
      if (!disposed) {
        setProbeFailureRecord({
          queryKeyIdentity,
          state: classifyOpsBridgeError(error),
        });
      }
    });
    return () => {
      disposed = true;
    };
  }, [hasCanonicalSnapshot, queryKeyIdentity, state, watchState]);

  const refetch = React.useCallback(async () => {
    await query.refetch({ cancelRefetch: false });
  }, [query.refetch]);

  return {
    state,
    snapshot,
    error: query.error,
    mutationsDisabled: opsMutationsDisabled(state, snapshot),
    refetch,
    watchState,
  };
}
