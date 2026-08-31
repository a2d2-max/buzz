import type * as React from "react";

import { classifyOpsBridgeError } from "../opsBridge";
import {
  opsGlobalBoundaryMode,
  type OpsGlobalCollectionStates,
} from "../opsGlobalCollections";
import type { OpsConnectionState as ConnectionState } from "../types";
import { OpsConnectionState } from "./OpsConnectionState";

const GLOBAL_STATE_LABELS = {
  work_items: "Work",
  sessions: "Sessions",
  checklist_items: "Plan",
  decisions: "Decisions",
  approval_index: "Approvals",
  evidence: "Evidence",
  audit: "Audit",
  search: "Search",
} as const;

export function opsGlobalStateNoticeMessages(
  states: OpsGlobalCollectionStates,
): string[] {
  return Object.entries(GLOBAL_STATE_LABELS).flatMap(([module, label]) => {
    const state = states[module as keyof OpsGlobalCollectionStates];
    if (
      !state ||
      state.status === "not_requested" ||
      state.status === "ready"
    ) {
      return [];
    }
    if (state.status === "pending") return [`${label} is loading.`];
    if (state.status === "disconnected") return [`${label} is disconnected.`];
    if (state.status === "unavailable") return [`${label} is unavailable.`];
    if (state.status === "contract_invalid") {
      return [`${label} contract is invalid.`];
    }
    return [`${label} changed again. Retry required.`];
  });
}

export function opsWorkRouteMode(
  selectedWorkId: string | null,
  workItems: readonly { id: string }[],
  state: OpsGlobalCollectionStates["work_items"],
):
  | "contract_invalid"
  | "disconnected"
  | "empty"
  | "pending"
  | "retry_required"
  | "selected"
  | "unavailable"
  | "updating" {
  if (state && state.status !== "ready") {
    return state.status === "not_requested" ? "pending" : state.status;
  }
  if (workItems.length === 0) return "empty";
  return selectedWorkId ? "selected" : "updating";
}

export function opsSourceConnectionState(
  capabilitiesReady: boolean,
  capabilityError: unknown,
  snapshotState: ConnectionState,
): ConnectionState {
  if (
    snapshotState === "version_mismatch" ||
    snapshotState === "contract_invalid" ||
    snapshotState === "not_configured"
  ) {
    return snapshotState;
  }
  if (capabilityError) return classifyOpsBridgeError(capabilityError);
  if (!capabilitiesReady) return snapshotState;
  return snapshotState === "disconnected" || snapshotState === "loading"
    ? "ready"
    : snapshotState;
}

export function opsSourceRoutePending(
  capabilities: unknown,
  capabilityError: unknown,
): boolean {
  return capabilities === undefined && !capabilityError;
}

function OpsGlobalStateNotices({
  pending,
  states,
}: {
  pending: boolean;
  states: OpsGlobalCollectionStates;
}) {
  if (pending) {
    return (
      <p
        className="border-border border-b px-4 py-2 text-xs text-muted-foreground"
        role="status"
      >
        Loading complete local collections…
      </p>
    );
  }
  const notices = opsGlobalStateNoticeMessages(states);
  if (notices.length === 0) return null;
  return (
    <div
      aria-label="Collection status"
      className="flex flex-wrap gap-x-4 gap-y-1 border-border border-b px-4 py-2 text-xs text-amber-300"
      role="status"
    >
      {notices.map((notice) => (
        <span key={notice}>{notice}</span>
      ))}
    </div>
  );
}

export function OpsGlobalRouteBoundary({
  children,
  connectionState,
  onRetry,
  pending,
  showNotices = true,
  states,
}: {
  children: React.ReactNode;
  connectionState: ConnectionState;
  onRetry: () => void;
  pending: boolean;
  showNotices?: boolean;
  states: OpsGlobalCollectionStates;
}) {
  const mode = opsGlobalBoundaryMode(connectionState, pending, states);
  if (mode === "connection") {
    return <OpsConnectionState onRetry={onRetry} state={connectionState} />;
  }
  if (mode === "loading") {
    return <OpsConnectionState onRetry={onRetry} state="loading" />;
  }
  const allUnavailable = Object.keys(GLOBAL_STATE_LABELS).every(
    (module) =>
      states[module as keyof OpsGlobalCollectionStates]?.status ===
      "unavailable",
  );
  if (!pending && allUnavailable) {
    return (
      <div className="flex min-h-56 flex-1 flex-col items-center justify-center px-6 text-center">
        <h2 className="text-base font-semibold">Hub 준비 전</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Home·Work data unavailable
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {connectionState === "stale" ? (
        <OpsConnectionState onRetry={onRetry} state="stale" />
      ) : null}
      {showNotices ? (
        <OpsGlobalStateNotices pending={pending} states={states} />
      ) : null}
      {children}
    </div>
  );
}
