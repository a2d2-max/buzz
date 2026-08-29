import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import {
  type OpsBridgeCapabilitiesV1,
  type OpsBridgeSnapshotV1,
  type OpsConnectionState,
  type OpsSelection,
  opsCapabilitiesSchema,
  opsSnapshotEnvelopeSchema,
  looksLikeAbsolutePath,
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

const watchStartSchema = z.object({ started: z.boolean() }).strip();

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

function hasAbsolutePath(value: unknown): boolean {
  if (typeof value === "string") return looksLikeAbsolutePath(value);
  if (Array.isArray(value)) return value.some(hasAbsolutePath);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(hasAbsolutePath);
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
  if (hasAbsolutePath(value)) throw new OpsBridgeContractError();
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

export async function startOpsWatch(): Promise<{ started: boolean }> {
  const value = await invoke<unknown>("ops_bridge_start_watch", null as never);
  const parsed = watchStartSchema.safeParse(value);
  if (!parsed.success) throw new OpsBridgeContractError();
  return parsed.data;
}

export function hasInvalidOpsModule(snapshot: OpsBridgeSnapshotV1): boolean {
  return Object.values(snapshot.module_states).some(
    (module) => module.status === "contract_invalid",
  );
}
