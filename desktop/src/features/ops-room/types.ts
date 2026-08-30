import { z } from "zod";
import {
  OPS_MODULE_NAMES,
  OPS_MODULE_PAGED_TOPOLOGY,
  type OpsBridgeCapabilitiesV1,
  type OpsModuleName,
} from "./opsCapabilities";
export {
  OPS_MODULE_NAMES,
  OPS_MODULE_PAGED_TOPOLOGY,
  opsCapabilitiesSchema,
  opsModuleCapabilitySchema,
  type OpsBridgeCapabilitiesV1,
  type OpsInvalidKnownModuleCapabilityV1,
  type OpsModuleCapabilityV1,
  type OpsModuleName,
  type OpsValidModuleCapabilityV1,
} from "./opsCapabilities";
import {
  opsConnectionSchema as strictOpsConnectionSchema,
  opsConnectionsSchema,
  opsRepositoryStatusSchema as strictOpsRepositoryStatusSchema,
  opsResearchCardSchema as strictOpsResearchCardSchema,
  opsSafetyPolicySchema,
  opsTeamsActivitySchema,
  opsWorkflowRoutingSchema as strictOpsWorkflowRoutingSchema,
} from "./opsTask5Contracts";

const ABSOLUTE_PATH =
  /^(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|Volumes|Library|Applications|System|home|root|private|tmp|var|etc|opt|workspace|mnt|srv|usr|bin|sbin|lib|lib64|proc|run|dev|sys|boot|media|nix|snap)(?:\/|$))/i;

export function looksLikeAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH.test(value);
}

export function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === "string") return looksLikeAbsolutePath(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      looksLikeAbsolutePath(key) || containsAbsolutePath(nested),
  );
}

const publicString = z
  .string()
  .refine((value) => !looksLikeAbsolutePath(value), "absolute path is private");
const requiredPublicString = publicString.min(1);
const nullablePublicString = publicString.nullable();
const nonNegativeInteger = z.number().int().nonnegative();
export const opsEventSequenceSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const publicDetails = z.record(z.string(), z.unknown()).default({});

export const opsHealthSchema = z
  .object({
    hub: z.enum(["ready", "degraded"]),
    orca: requiredPublicString,
    codex: requiredPublicString,
  })
  .strip();

export const opsSessionNodeSchema = z
  .object({
    id: requiredPublicString,
    source: z.enum(["orca", "codex_direct", "codex_sub", "claude_code"]),
    parent_session_id: nullablePublicString,
    work_item_id: nullablePublicString,
    title: requiredPublicString,
    activity: nullablePublicString,
    health: requiredPublicString,
    last_activity_at: nullablePublicString,
    child_ids: z.array(requiredPublicString),
  })
  .strip();

export type OpsSessionNodeV1 = z.infer<typeof opsSessionNodeSchema>;

export const opsRoomChannelSchema = z
  .object({
    id: requiredPublicString,
    project_id: nullablePublicString,
    label: requiredPublicString,
    count: nonNegativeInteger,
  })
  .strip();

export const opsRoomThreadSchema = z
  .object({
    id: requiredPublicString,
    type: z.enum(["work", "session"]),
    work_item_id: nullablePublicString,
    session_id: nullablePublicString,
    project_id: nullablePublicString,
    title: requiredPublicString,
    status: requiredPublicString,
    provider: nullablePublicString,
    updated_at: requiredPublicString,
    session_count: nonNegativeInteger,
    approval_count: nonNegativeInteger,
    artifact_count: nonNegativeInteger,
  })
  .strip();

export const opsRoomMessageSchema = z
  .object({
    id: requiredPublicString,
    kind: z.enum([
      "instruction",
      "delegation",
      "status",
      "question",
      "completion",
      "artifact",
      "approval",
    ]),
    timestamp: requiredPublicString,
    role: requiredPublicString,
    author: requiredPublicString,
    body: requiredPublicString,
    details: publicDetails,
  })
  .strip();

const providerEffortSchema = z
  .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
  .nullable();

export const opsWorkItemSchema = z
  .object({
    id: requiredPublicString,
    project_id: nullablePublicString,
    title: requiredPublicString,
    status: requiredPublicString,
    progress: z.number().min(0).max(1).nullable(),
    last_activity_at: nullablePublicString,
    execution_provider: nullablePublicString,
    provider_model: nullablePublicString,
    provider_effort: providerEffortSchema,
    revision: nonNegativeInteger,
    updated_at: requiredPublicString,
  })
  .strip();

export const opsProviderRunSchema = z
  .object({
    id: requiredPublicString,
    work_item_id: requiredPublicString,
    provider: requiredPublicString,
    model: requiredPublicString,
    provider_effort: providerEffortSchema,
    provenance: z
      .object({
        source: z.enum([
          "user_selection",
          "master_assignment",
          "adapter_observed",
        ]),
        source_ref: requiredPublicString,
      })
      .nullable(),
    session_id: nullablePublicString,
    status: requiredPublicString,
    approval_id: requiredPublicString,
    revision: nonNegativeInteger,
    created_at: requiredPublicString,
    updated_at: requiredPublicString,
  })
  .strip();

export const opsContextSessionSchema = z
  .object({
    id: requiredPublicString,
    work_item_id: nullablePublicString,
    project_id: nullablePublicString,
    parent_session_id: nullablePublicString,
    title: nullablePublicString,
    agent: requiredPublicString,
    activity: nullablePublicString,
    health: requiredPublicString,
    health_reason: nullablePublicString,
    last_activity_at: nullablePublicString,
    execution_provider: nullablePublicString,
    provider_model: nullablePublicString,
    provider_effort: providerEffortSchema,
    revision: nonNegativeInteger,
    updated_at: requiredPublicString,
  })
  .strip();

export const opsApprovalSchema = z
  .object({
    id: requiredPublicString,
    work_item_id: requiredPublicString,
    target_session_id: nullablePublicString,
    draft_text: requiredPublicString,
    action_kind: requiredPublicString,
    status: requiredPublicString,
    hold_reason: nullablePublicString,
    risk_class: z.array(requiredPublicString),
    risk_targets: z.array(requiredPublicString),
    approved_at: nullablePublicString,
    revision: nonNegativeInteger,
    updated_at: requiredPublicString,
  })
  .strip();

export const opsArtifactSchema = z
  .object({
    id: requiredPublicString,
    work_item_id: requiredPublicString,
    title: requiredPublicString,
    kind: requiredPublicString,
    status: requiredPublicString,
    version: nonNegativeInteger,
    source_event_id: nullablePublicString,
    created_at: requiredPublicString,
    updated_at: requiredPublicString,
  })
  .strip();

export const opsRoomContextSchema = z
  .object({
    work_item: opsWorkItemSchema.nullable(),
    provider_run: opsProviderRunSchema.nullable(),
    sessions: z.array(opsContextSessionSchema),
    approvals: z.array(opsApprovalSchema),
    artifacts: z.array(opsArtifactSchema),
  })
  .strip();

const roomKnownSchema = z
  .object({
    channels: z.array(opsRoomChannelSchema),
    selected_channel_id: requiredPublicString,
    threads: z.array(opsRoomThreadSchema),
    selected_thread_id: nullablePublicString,
    messages: z.array(opsRoomMessageSchema),
    context: opsRoomContextSchema,
    diagnostics: publicDetails.optional(),
  })
  .passthrough();

export type OpsRoomV1 = Omit<z.infer<typeof roomKnownSchema>, string> & {
  channels: Array<z.infer<typeof opsRoomChannelSchema>>;
  selected_channel_id: string;
  threads: Array<z.infer<typeof opsRoomThreadSchema>>;
  selected_thread_id: string | null;
  messages: Array<z.infer<typeof opsRoomMessageSchema>>;
  context: z.infer<typeof opsRoomContextSchema>;
  diagnostics?: Record<string, unknown>;
  extensions: Record<string, unknown>;
};

const ROOM_KNOWN_KEYS = new Set([
  "channels",
  "selected_channel_id",
  "threads",
  "selected_thread_id",
  "messages",
  "context",
  "diagnostics",
]);

export function parseOpsRoom(value: unknown): OpsRoomV1 {
  const room = roomKnownSchema.parse(value);
  const extensions = Object.fromEntries(
    Object.entries(room).filter(([key]) => !ROOM_KNOWN_KEYS.has(key)),
  );
  return {
    channels: room.channels,
    selected_channel_id: room.selected_channel_id,
    threads: room.threads,
    selected_thread_id: room.selected_thread_id,
    messages: room.messages,
    context: room.context,
    ...(room.diagnostics === undefined
      ? {}
      : { diagnostics: room.diagnostics }),
    extensions,
  };
}

export const opsChecklistItemSchema = z
  .object({
    id: requiredPublicString,
    revision: nonNegativeInteger.optional(),
    work_item_id: requiredPublicString.optional(),
    key: requiredPublicString.optional(),
    title: requiredPublicString,
    order: nonNegativeInteger.optional(),
    origin: requiredPublicString.optional(),
    status: requiredPublicString,
    evidence_ids: z.array(requiredPublicString).optional(),
    claimed_by_session_id: nullablePublicString.optional(),
    claimed_at: nullablePublicString.optional(),
    done_reason: nullablePublicString.optional(),
    note: nullablePublicString.optional(),
    checked_at: nullablePublicString.optional(),
    stage: nullablePublicString.optional(),
    next_action: nullablePublicString.optional(),
    created_at: requiredPublicString.optional(),
    updated_at: requiredPublicString.optional(),
  })
  .strip();

export const opsDecisionSchema = z
  .object({
    id: requiredPublicString,
    queue: z.enum([
      "user_decision",
      "external_wait",
      "agent_autonomous",
      "needs_info",
    ]),
    source: z.enum(["checklist", "approval", "message", "attention"]),
    title: requiredPublicString,
    question: requiredPublicString,
    approval_id: requiredPublicString.optional(),
    item_id: requiredPublicString.optional(),
    options: z.array(requiredPublicString).optional(),
    needed_input: nullablePublicString.optional(),
    impact: nullablePublicString.optional(),
    asked_at: nullablePublicString.optional(),
    stale: z.boolean().optional(),
  })
  .strip();

export const opsTimelineItemSchema = z
  .object({
    id: requiredPublicString,
    timestamp: requiredPublicString,
    kind: requiredPublicString,
    author: requiredPublicString,
    body: requiredPublicString,
    source: requiredPublicString.optional(),
    outcome: nullablePublicString.optional(),
    details: publicDetails.optional(),
  })
  .strip();

export const opsConnectionSchema = strictOpsConnectionSchema;
export const opsWorkflowRoutingSchema = strictOpsWorkflowRoutingSchema;
export const opsResearchCardSchema = strictOpsResearchCardSchema;
export const opsRepositoryStatusSchema = strictOpsRepositoryStatusSchema;

const optionalModuleSchemas = {
  timeline: z.array(opsTimelineItemSchema),
  approvals: z.array(opsApprovalSchema),
  artifacts: z.array(opsArtifactSchema),
  connections: opsConnectionsSchema,
  workflow_routing: opsWorkflowRoutingSchema,
  safety_policy: opsSafetyPolicySchema,
  research: z.array(opsResearchCardSchema),
  repositories: z.array(opsRepositoryStatusSchema),
  teams_activity: z.array(opsTeamsActivitySchema),
} as const;

export type OpsModuleData = {
  [Name in OpsModuleName]: Name extends keyof typeof optionalModuleSchemas
    ? z.infer<(typeof optionalModuleSchemas)[Name]>
    : never;
};

export type OpsModuleState<T> =
  | { status: "unavailable" }
  | { status: "ready"; data: T }
  | { status: "contract_invalid" };

export type OpsModuleStates = {
  [Name in OpsModuleName]: OpsModuleState<OpsModuleData[Name]>;
};

export interface OpsBridgeSnapshotV1 {
  contract_version: 1;
  revision: number;
  generated_at: string;
  health: z.infer<typeof opsHealthSchema>;
  room: OpsRoomV1;
  session_tree: OpsSessionNodeV1[];
  checklist: Array<z.infer<typeof opsChecklistItemSchema>>;
  decisions: Array<z.infer<typeof opsDecisionSchema>>;
  event_sequence?: string;
  module_states: OpsModuleStates;
}

export const opsSnapshotEnvelopeSchema = z
  .object({
    contract_version: z.literal(1),
    revision: nonNegativeInteger,
    generated_at: requiredPublicString,
    health: opsHealthSchema,
    room: z.unknown(),
    session_tree: z.array(opsSessionNodeSchema),
    checklist: z.array(opsChecklistItemSchema),
    decisions: z.array(opsDecisionSchema),
    event_sequence: opsEventSequenceSchema.optional(),
  })
  .passthrough();

export function parseOpsModuleStates(
  snapshot: Record<string, unknown>,
  capabilities: OpsBridgeCapabilitiesV1,
): OpsModuleStates {
  return Object.fromEntries(
    OPS_MODULE_NAMES.map((name) => {
      const capability = capabilities.modules?.find(
        (module) => module.name === name,
      );
      if (!capability) return [name, { status: "unavailable" }];
      if (
        "contract_invalid" in capability ||
        capability.paged !== OPS_MODULE_PAGED_TOPOLOGY[name]
      )
        return [name, { status: "contract_invalid" }];
      if (capability.paged || !(name in optionalModuleSchemas))
        return [name, { status: "unavailable" }];
      const parsed = optionalModuleSchemas[
        name as keyof typeof optionalModuleSchemas
      ].safeParse(snapshot[name]);
      return parsed.success
        ? [name, { status: "ready", data: parsed.data }]
        : [name, { status: "contract_invalid" }];
    }),
  ) as OpsModuleStates;
}

export interface OpsSelection {
  channel?: string | null;
  thread?: string | null;
  limit?: number;
}

export type OpsConnectionState =
  | "loading"
  | "ready"
  | "stale"
  | "disconnected"
  | "not_configured"
  | "version_mismatch"
  | "contract_invalid";
