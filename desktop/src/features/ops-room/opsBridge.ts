import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import {
  type OpsBridgeCapabilitiesV1,
  type OpsBridgeSnapshotV1,
  type OpsConnectionState,
  type OpsSelection,
  containsAbsolutePath,
  opsArtifactSchema,
  opsCapabilitiesSchema,
  opsEventSequenceSchema,
  opsRepositoryStatusSchema,
  opsResearchCardSchema,
  opsSnapshotEnvelopeSchema,
  opsTimelineItemSchema,
  parseOpsModuleStates,
  parseOpsRoom,
} from "./types";

const selectionSchema = z
  .object({
    channel: z.string().min(1).nullable(),
    thread: z.string().min(1).nullable(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();

const watchStartSchema = z
  .object({
    started: z.boolean(),
    connection_generation: z.number().int().nonnegative(),
    sync_required: z.boolean(),
    anchor_sequence: opsEventSequenceSchema.nullable(),
  })
  .strip();
const syncAckSchema = z
  .object({
    accepted: z.boolean(),
    connection_generation: z.number().int().nonnegative(),
  })
  .strip();

const opsPageModuleSchema = z.enum([
  "timeline",
  "artifacts",
  "research",
  "repositories",
]);
const opsPageRequestSchema = z.discriminatedUnion("module", [
  z
    .object({
      module: z.literal("timeline"),
      scope: z
        .object({
          channel: z.string().min(1).nullable(),
          thread: z.string().min(1).nullable(),
          sort: z.literal("occurred_at_desc"),
        })
        .strict(),
      page_size: z.number().int().min(1).max(200),
      cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      module: z.literal("artifacts"),
      scope: z
        .object({
          work_item: z.string().min(1).nullable(),
          representation: z.enum(["rendered", "preview"]).nullable(),
          sort: z.literal("created_at_desc"),
        })
        .strict(),
      page_size: z.number().int().min(1).max(200),
      cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      module: z.literal("research"),
      scope: z
        .object({
          work_item: z.string().min(1).nullable(),
          sort: z.literal("created_at_desc"),
        })
        .strict(),
      page_size: z.number().int().min(1).max(200),
      cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict(),
  z
    .object({
      module: z.literal("repositories"),
      scope: z
        .object({
          project: z.string().min(1).nullable(),
          sort: z.literal("display_name_asc"),
        })
        .strict(),
      page_size: z.number().int().min(1).max(200),
      cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict(),
]);

const opsPageItemSchemas = {
  timeline: opsTimelineItemSchema.strict(),
  artifacts: opsArtifactSchema.strict(),
  research: opsResearchCardSchema.strict(),
  repositories: opsRepositoryStatusSchema.strict(),
} as const;

const opsPageErrorSchema = z
  .object({ error: z.enum(["invalid_cursor", "stale_cursor"]) })
  .strict();

export type OpsPageModule = z.infer<typeof opsPageModuleSchema>;
type OpsPageRequestBase = { page_size?: number; cursor?: string | null };
export type OpsPageRequest =
  | (OpsPageRequestBase & {
      module: "timeline";
      scope: {
        channel: string | null;
        thread: string | null;
        sort: "occurred_at_desc";
      };
    })
  | (OpsPageRequestBase & {
      module: "artifacts";
      scope: {
        work_item: string | null;
        representation: "rendered" | "preview" | null;
        sort: "created_at_desc";
      };
    })
  | (OpsPageRequestBase & {
      module: "research";
      scope: { work_item: string | null; sort: "created_at_desc" };
    })
  | (OpsPageRequestBase & {
      module: "repositories";
      scope: { project: string | null; sort: "display_name_asc" };
    });

export interface OpsPageV1<T = unknown> {
  contract_version: 1;
  revision: number;
  generated_at: string;
  items: T[];
  next_cursor: string | null;
}

export class OpsPageError extends Error {
  readonly code: "invalid_cursor" | "stale_cursor";

  constructor(code: "invalid_cursor" | "stale_cursor") {
    super(code);
    this.name = "OpsPageError";
    this.code = code;
  }
}

const NOT_CONFIGURED_CODES = new Set([
  "ops_bridge_invalid_config",
  "ops_bridge_token_unavailable",
  "ops_bridge_token_permissions",
  "ops_bridge_token_invalid",
]);

export class OpsBridgeVersionMismatchError extends Error {
  constructor() {
    super("ops_bridge_version_mismatch");
    this.name = "OpsBridgeVersionMismatchError";
  }
}

export class OpsBridgeContractError extends Error {
  constructor() {
    super("ops_bridge_contract_invalid");
    this.name = "OpsBridgeContractError";
  }
}

class OpsPageRevisionMismatchError extends OpsBridgeContractError {}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "";
}

export function classifyOpsBridgeError(error: unknown): OpsConnectionState {
  const message = errorMessage(error);
  if (NOT_CONFIGURED_CODES.has(message)) return "not_configured";
  if (message === "ops_bridge_contract_mismatch") return "version_mismatch";
  if (error instanceof OpsBridgeVersionMismatchError) return "version_mismatch";
  if (error instanceof OpsBridgeContractError) return "contract_invalid";
  return "disconnected";
}

function requireVersionOne(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).contract_version !== "number" ||
    (value as Record<string, unknown>).contract_version !== 1
  ) {
    throw new OpsBridgeVersionMismatchError();
  }
}

function parseCapabilities(value: unknown): OpsBridgeCapabilitiesV1 {
  requireVersionOne(value);
  const parsed = opsCapabilitiesSchema.safeParse(value);
  if (!parsed.success) throw new OpsBridgeContractError();
  const moduleNames = parsed.data.modules?.map((module) => module.name) ?? [];
  if (new Set(moduleNames).size !== moduleNames.length) {
    throw new OpsBridgeContractError();
  }
  return parsed.data;
}

function parseSnapshot(
  value: unknown,
  capabilities: OpsBridgeCapabilitiesV1,
): OpsBridgeSnapshotV1 {
  requireVersionOne(value);
  if (containsAbsolutePath(value)) throw new OpsBridgeContractError();
  const parsed = opsSnapshotEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new OpsBridgeContractError();
  try {
    return {
      contract_version: 1,
      revision: parsed.data.revision,
      generated_at: parsed.data.generated_at,
      health: parsed.data.health,
      room: parseOpsRoom(parsed.data.room),
      session_tree: parsed.data.session_tree,
      checklist: parsed.data.checklist,
      decisions: parsed.data.decisions,
      ...(parsed.data.event_sequence === undefined
        ? {}
        : { event_sequence: parsed.data.event_sequence }),
      module_states: parseOpsModuleStates(
        value as Record<string, unknown>,
        capabilities,
      ),
    };
  } catch (error) {
    if (error instanceof OpsBridgeContractError) throw error;
    throw new OpsBridgeContractError();
  }
}

function normalizeSelection(selection: OpsSelection) {
  const normalized = {
    channel: selection.channel ?? null,
    thread: selection.thread ?? null,
    limit: selection.limit ?? 100,
  };
  const parsed = selectionSchema.safeParse(normalized);
  if (!parsed.success) throw new OpsBridgeContractError();
  return parsed.data;
}

function normalizePageRequest(request: OpsPageRequest) {
  const parsed = opsPageRequestSchema.safeParse({
    ...request,
    page_size: request.page_size ?? 100,
    cursor: request.cursor ?? null,
  });
  if (!parsed.success) throw new OpsBridgeContractError();
  return parsed.data;
}

function parsePage(
  value: unknown,
  module: OpsPageModule,
  expectedCollectionRevision: number,
): OpsPageV1 {
  requireVersionOne(value);
  if (
    !Number.isSafeInteger(expectedCollectionRevision) ||
    expectedCollectionRevision < 0 ||
    containsAbsolutePath(value)
  ) {
    throw new OpsBridgeContractError();
  }
  const schema = z
    .object({
      contract_version: z.literal(1),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      generated_at: z.string().min(1),
      items: z.array(opsPageItemSchemas[module]),
      next_cursor: z.string().min(1).max(4096).nullable(),
    })
    .strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpsBridgeContractError();
  }
  if (parsed.data.revision !== expectedCollectionRevision) {
    throw new OpsPageRevisionMismatchError();
  }
  return parsed.data;
}

export function opsSnapshotQueryKey(selection: OpsSelection) {
  return [
    "ops",
    "snapshot",
    selection.channel ?? null,
    selection.thread ?? null,
    selection.limit ?? 100,
  ] as const;
}

export async function getOpsCapabilities(): Promise<OpsBridgeCapabilitiesV1> {
  const value = await invoke<unknown>("ops_bridge_capabilities", null as never);
  return parseCapabilities(value);
}

export async function getOpsSnapshot(
  selection: OpsSelection,
  capabilities: OpsBridgeCapabilitiesV1 = {
    contract_version: 1,
    reads: ["snapshot", "events", "artifact"],
    drafts: [],
    transitions: [],
  },
): Promise<OpsBridgeSnapshotV1> {
  const value = await invoke<unknown>("ops_bridge_snapshot", {
    selection: normalizeSelection(selection),
  });
  return parseSnapshot(value, capabilities);
}

export async function loadOpsSnapshot(
  selection: OpsSelection,
): Promise<OpsBridgeSnapshotV1> {
  const capabilities = await getOpsCapabilities();
  return getOpsSnapshot(selection, capabilities);
}

export async function getOpsPage(
  request: OpsPageRequest,
  expectedCollectionRevision: number,
): Promise<OpsPageV1> {
  const normalized = normalizePageRequest(request);
  try {
    const value = await invoke<unknown>("ops_bridge_page", {
      request: normalized,
    });
    return parsePage(value, normalized.module, expectedCollectionRevision);
  } catch (error) {
    const parsed = opsPageErrorSchema.safeParse(error);
    if (parsed.success) throw new OpsPageError(parsed.data.error);
    throw error;
  }
}

export async function loadOpsPageWithStaleRestart(
  request: OpsPageRequest,
  expectedCollectionRevision: number,
): Promise<OpsPageV1> {
  try {
    return await getOpsPage(request, expectedCollectionRevision);
  } catch (error) {
    const staleCursor =
      error instanceof OpsPageError &&
      error.code === "stale_cursor" &&
      request.cursor != null;
    const racedFirstPage =
      error instanceof OpsPageRevisionMismatchError && request.cursor == null;
    if (!staleCursor && !racedFirstPage) {
      throw error;
    }
  }

  const capabilities = await getOpsCapabilities();
  const module = capabilities.modules?.find(
    (candidate) => candidate.name === request.module,
  );
  if (
    !module?.paged ||
    module.schema_version !== 1 ||
    module.collection_revision === undefined
  ) {
    throw new OpsBridgeContractError();
  }
  return getOpsPage(
    { ...request, cursor: null } as OpsPageRequest,
    module.collection_revision,
  );
}

export async function startOpsWatch(): Promise<
  z.infer<typeof watchStartSchema>
> {
  const value = await invoke<unknown>("ops_bridge_start_watch", null as never);
  const parsed = watchStartSchema.safeParse(value);
  if (!parsed.success) throw new OpsBridgeContractError();
  return parsed.data;
}

export async function stopOpsWatch(): Promise<void> {
  await invoke<void>("ops_bridge_stop_watch", null as never);
}

export async function acknowledgeOpsSync(
  generation: number,
  appliedSequence: string,
): Promise<{ accepted: boolean; connection_generation: number }> {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new OpsBridgeContractError();
  }
  if (!opsEventSequenceSchema.safeParse(appliedSequence).success) {
    throw new OpsBridgeContractError();
  }
  const value = await invoke<unknown>("ops_bridge_ack_sync", {
    request: { generation, applied_sequence: appliedSequence },
  });
  const parsed = syncAckSchema.safeParse(value);
  if (!parsed.success) throw new OpsBridgeContractError();
  return parsed.data;
}

export function hasInvalidOpsModule(snapshot: OpsBridgeSnapshotV1): boolean {
  return Object.values(snapshot.module_states).some(
    (module) => module.status === "contract_invalid",
  );
}
