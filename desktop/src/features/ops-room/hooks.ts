import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  classifyOpsBridgeError,
  getOpsCapabilities,
  hasInvalidOpsModule,
  loadOpsSnapshot,
  opsSnapshotQueryKey,
} from "./opsBridge";
import {
  ensureOpsWatchManager,
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
  refetch: () => Promise<void>;
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
  if (snapshot && hasInvalidOpsModule(snapshot)) return "contract_invalid";
  if (snapshot) return "ready";
  return pending ? "loading" : "disconnected";
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
  const activeQueryKey = React.useRef(queryKey);
  activeQueryKey.current = queryKey;
  const lastGoodSnapshot = React.useRef<{
    queryKeyIdentity: string;
    snapshot: OpsBridgeSnapshotV1;
  } | null>(null);
  const [probeFailureRecord, setProbeFailureRecord] = React.useState<{
    queryKeyIdentity: string;
    state: OpsConnectionState;
  } | null>(null);

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
  const state = lifecycleState(
    snapshot,
    query.isPending,
    query.error,
    probeFailure,
  );

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
    (payload: { full_reload?: boolean }) => {
      if (payload.full_reload === true) {
        void queryClient.invalidateQueries({ queryKey: ["ops"] });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: activeQueryKey.current,
        exact: true,
      });
    },
    [queryClient],
  );

  React.useEffect(() => {
    if (!hasCanonicalSnapshot) return;
    return subscribeOpsInvalidations(handleInvalidation);
  }, [handleInvalidation, hasCanonicalSnapshot]);

  React.useEffect(() => {
    if (!hasCanonicalSnapshot || state !== "ready") return;
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
  }, [hasCanonicalSnapshot, queryKeyIdentity, state]);

  const refetch = React.useCallback(async () => {
    await query.refetch({ cancelRefetch: false });
  }, [query.refetch]);

  return { state, snapshot, error: query.error, refetch };
}
