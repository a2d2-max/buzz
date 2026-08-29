import type {
  OpsBridgeSnapshotV1,
  OpsSelection,
  OpsSessionNodeV1,
} from "./types";

const SOURCE_LABELS = {
  orca: "Orca",
  codex_direct: "Codex",
  codex_sub: "Codex sub",
  claude_code: "Claude Code",
} as const;

const MESSAGE_VERBS = {
  instruction: "지시",
  delegation: "위임",
  status: "진행",
  question: "질문",
  completion: "완료",
  artifact: "산출물",
  approval: "승인",
} as const;

const DETAIL_KEYS = ["phase", "status", "summary", "tests"] as const;
const TIMELINE_SUMMARY_LIMIT = 140;
const TIMELINE_DISCLOSURE_LIMIT = 2_000;

export interface OpsProjectedChannel {
  id: string;
  label: string;
  count: number;
}

export interface OpsProjectedThread {
  id: string;
  title: string;
  status: string;
  provider: string | null;
  sessionCount: number;
  approvalCount: number;
  artifactCount: number;
}

export interface OpsProjectedSession {
  id: string;
  parentSessionId: string | null;
  title: string;
  sourceLabel: string;
  activity: string | null;
  health: string;
  depth: number;
}

export interface OpsProjectedTimelineItem {
  id: string;
  timestamp: string;
  author: string;
  verb: string;
  outcome: string | null;
  sourceLabel: string;
  summary: string;
  body: string;
  details: Array<{ label: string; value: string }>;
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export interface OpsProjectedContext {
  workItem: {
    id: string;
    title: string;
    status: string;
    progress: number | null;
  } | null;
  provider: {
    provider: string;
    model: string;
    effort: string | null;
    status: string;
  } | null;
  sessions: Array<{
    id: string;
    title: string;
    agent: string;
    activity: string | null;
    health: string;
  }>;
  checklist: Array<{ id: string; title: string; status: string }>;
  decisions: Array<{
    id: string;
    title: string;
    question: string;
    queue: string;
  }>;
  approvals: Array<{
    id: string;
    actionKind: string;
    status: string;
    holdReason: string | null;
  }>;
  artifacts: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    version: number;
  }>;
}

export interface OpsRoomProjection {
  workspace: {
    channels: OpsProjectedChannel[];
    selectedChannelId: string;
    threads: OpsProjectedThread[];
    selectedThreadId: string | null;
  };
  sessions: OpsProjectedSession[];
  timeline: OpsProjectedTimelineItem[];
  context: OpsProjectedContext;
  generatedAt: string;
}

function displaySource(source: unknown, fallback: string): string {
  if (typeof source === "string" && source in SOURCE_LABELS) {
    return SOURCE_LABELS[source as keyof typeof SOURCE_LABELS];
  }
  return fallback;
}

function projectedSessions(nodes: OpsSessionNodeV1[]): OpsProjectedSession[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const output: OpsProjectedSession[] = [];

  const append = (node: OpsSessionNodeV1, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    output.push({
      id: node.id,
      parentSessionId: node.parent_session_id,
      title: node.title,
      sourceLabel: SOURCE_LABELS[node.source],
      activity: node.activity,
      health: node.health,
      depth,
    });
    for (const childId of node.child_ids) {
      const child = byId.get(childId);
      if (child) append(child, depth + 1);
    }
  };

  for (const node of nodes) {
    if (node.parent_session_id === null || !byId.has(node.parent_session_id)) {
      append(node, 0);
    }
  }
  for (const node of nodes) append(node, 0);
  return output;
}

function projectedDetails(
  details: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  return DETAIL_KEYS.flatMap((key) => {
    const value = details[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return [];
    }
    return [{ label: key, value: String(value).slice(0, 240) }];
  });
}

function timestampOrder(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

export function projectOpsRoom(
  snapshot: OpsBridgeSnapshotV1,
): OpsRoomProjection {
  const selectedWorkItemId = snapshot.room.context.work_item?.id ?? null;
  const providerRun = snapshot.room.context.provider_run;
  const workItem = snapshot.room.context.work_item;
  const provider = providerRun
    ? {
        provider: providerRun.provider,
        model: providerRun.model,
        effort: providerRun.provider_effort,
        status: providerRun.status,
      }
    : workItem?.execution_provider && workItem.provider_model
      ? {
          provider: workItem.execution_provider,
          model: workItem.provider_model,
          effort: workItem.provider_effort,
          status: workItem.status,
        }
      : null;

  return {
    workspace: {
      channels: snapshot.room.channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        count: channel.count,
      })),
      selectedChannelId: snapshot.room.selected_channel_id,
      threads: snapshot.room.threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: thread.status,
        provider: thread.provider,
        sessionCount: thread.session_count,
        approvalCount: thread.approval_count,
        artifactCount: thread.artifact_count,
      })),
      selectedThreadId: snapshot.room.selected_thread_id,
    },
    sessions: projectedSessions(snapshot.session_tree),
    timeline: snapshot.room.messages
      .map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        author: message.author,
        verb: MESSAGE_VERBS[message.kind],
        outcome:
          typeof message.details.outcome === "string"
            ? message.details.outcome
            : null,
        sourceLabel: displaySource(message.details.source, message.author),
        summary: boundedText(message.body, TIMELINE_SUMMARY_LIMIT),
        body: boundedText(message.body, TIMELINE_DISCLOSURE_LIMIT),
        details: projectedDetails(message.details),
      }))
      .sort(
        (left, right) =>
          timestampOrder(left.timestamp, right.timestamp) ||
          left.id.localeCompare(right.id),
      ),
    context: {
      workItem: workItem
        ? {
            id: workItem.id,
            title: workItem.title,
            status: workItem.status,
            progress:
              workItem.progress === null
                ? null
                : Math.max(0, Math.min(100, workItem.progress * 100)),
          }
        : null,
      provider,
      sessions: snapshot.room.context.sessions.map((session) => ({
        id: session.id,
        title: session.title ?? session.agent,
        agent: session.agent,
        activity: session.activity,
        health: session.health,
      })),
      checklist: snapshot.checklist
        .filter(
          (item) =>
            selectedWorkItemId === null ||
            item.work_item_id === undefined ||
            item.work_item_id === selectedWorkItemId,
        )
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
        })),
      decisions: snapshot.decisions.map((decision) => ({
        id: decision.id,
        title: decision.title,
        question: decision.question,
        queue: decision.queue,
      })),
      approvals: snapshot.room.context.approvals.map((approval) => ({
        id: approval.id,
        actionKind: approval.action_kind,
        status: approval.status,
        holdReason: approval.hold_reason,
      })),
      artifacts: snapshot.room.context.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        status: artifact.status,
        version: artifact.version,
      })),
    },
    generatedAt: snapshot.generated_at,
  };
}

export function parseOpsRoomHash(hash: string): Required<OpsSelection> {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const parsed = new URL(value || "/ops", "http://ops.local");
  if (parsed.pathname !== "/ops") {
    return { channel: null, thread: null, limit: 100 };
  }
  return {
    channel: parsed.searchParams.get("channel"),
    thread: parsed.searchParams.get("thread"),
    limit: 100,
  };
}

export function opsRoomHash(selection: OpsSelection): string {
  const params = new URLSearchParams({ view: "room" });
  if (selection.channel) params.set("channel", selection.channel);
  if (selection.thread) params.set("thread", selection.thread);
  return `#/ops?${params.toString()}`;
}

export function ensureOpsRoomHash(hash: string): string {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const parsed = new URL(value || "/ops", "http://ops.local");
  if (parsed.pathname !== "/ops") return opsRoomHash({});
  if (!parsed.searchParams.has("view")) parsed.searchParams.set("view", "room");
  return `#${parsed.pathname}?${parsed.searchParams.toString()}`;
}
