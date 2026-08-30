import type {
  DormantOpsItemByModule,
  DormantOpsModuleName,
} from "./opsDormantContracts";

export type OpsGlobalCollections = {
  workItems: DormantOpsItemByModule["work_items"][];
  sessions: DormantOpsItemByModule["sessions"][];
  checklist: DormantOpsItemByModule["checklist_items"][];
  decisions: DormantOpsItemByModule["decisions"][];
  approvals: DormantOpsItemByModule["approval_index"][];
  evidence: DormantOpsItemByModule["evidence"][];
  audit: DormantOpsItemByModule["audit"][];
  search: DormantOpsItemByModule["search"][];
};

export function reconcileOpsWorkSelection(
  selected: string | null,
  workItems: OpsGlobalCollections["workItems"],
): string | null {
  if (selected && workItems.some(({ id }) => id === selected)) return selected;
  return workItems[0]?.id ?? null;
}

export function projectOpsHome(collections: OpsGlobalCollections) {
  const attentionWork = collections.workItems.filter(({ status }) =>
    ["waiting_approval", "blocked", "failed"].includes(status),
  );
  const decisions = collections.decisions.filter(
    ({ status }) => status === "open",
  );
  const approvals = collections.approvals.filter(({ status }) =>
    [
      "pending_approval",
      "awaiting_risk_confirm",
      "held",
      "delivery_failed",
      "execution_failed",
    ].includes(status),
  );
  return {
    activeWork: collections.workItems.filter(({ status }) =>
      ["candidate", "active"].includes(status),
    ),
    activeSessions: collections.sessions.filter(({ activity }) =>
      ["working", "waiting_input"].includes(activity ?? ""),
    ),
    attention: [...attentionWork, ...decisions, ...approvals],
    recentDecisions: collections.decisions.slice(0, 5),
    recentEvidence: collections.evidence.slice(0, 5),
    recentAudit: collections.audit.slice(0, 5),
  };
}

export function projectOpsWork(
  collections: OpsGlobalCollections,
  selectedWorkId: string,
) {
  const workItem = collections.workItems.find(
    ({ id }) => id === selectedWorkId,
  );
  if (!workItem) return null;
  const inWork = <T extends { work_item_id: string | null }>(items: T[]) =>
    items.filter(({ work_item_id }) => work_item_id === selectedWorkId);
  return {
    workItem,
    sessions: inWork(collections.sessions),
    checklist: inWork(collections.checklist).sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    ),
    decisions: inWork(collections.decisions),
    approvals: inWork(collections.approvals),
    evidence: inWork(collections.evidence),
    audit: inWork(collections.audit),
    search: collections.search.filter(
      ({ work_item_id }) =>
        work_item_id === null || work_item_id === selectedWorkId,
    ),
  };
}

export type OpsSearchKind = DormantOpsItemByModule["search"]["kind"];

export function opsSearchRequest(
  q: string,
  kind?: OpsSearchKind,
  work?: string,
) {
  return {
    module: "search" as const,
    scope: {
      q,
      ...(kind ? { kind } : {}),
      ...(work ? { work } : {}),
      sort: "rank_desc_then_observed_at_desc" as const,
    },
  };
}

export function opsGlobalQueryIdentity(
  module: DormantOpsModuleName,
  capabilityRevision: number,
  scope: Record<string, unknown>,
) {
  return ["ops", "global", module, capabilityRevision, scope] as const;
}
