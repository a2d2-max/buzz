import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { publicId } from "./opsDormantContracts";
import {
  getDormantOpsPageStates,
  getOpsPage,
  isOpsPagedModuleGenerationCurrent,
  markOpsPagedModuleContractInvalid,
  OpsBridgeContractError,
  OpsPageError,
  prepareDormantState,
  setDormantState,
  capabilityKey,
  type OpsPageRequest,
  type OpsPageV1,
} from "./opsBridge";
import {
  opsRepositoryDetailSchema,
  opsResearchDetailSchema,
  type OpsRepositoryDetailV1,
  type OpsResearchDetailV1,
  type OpsTeamsActivityV1,
} from "./opsTask5Contracts";
import { containsAbsolutePath, type OpsBridgeCapabilitiesV1 } from "./types";

export class OpsDetailError extends Error {
  readonly code: "unavailable";

  constructor(code: "unavailable") {
    super(code);
    this.name = "OpsDetailError";
    this.code = code;
  }
}

const detailRequestSchema = z.object({ id: publicId }).strict();
const detailErrorSchema = z
  .object({ error: z.enum(["unavailable", "contract_invalid"]) })
  .strict();

async function getOpsDetail<T extends { id: string }>(
  command: "ops_bridge_research_detail" | "ops_bridge_repository_detail",
  request: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const normalized = detailRequestSchema.safeParse(request);
  if (!normalized.success) throw new OpsBridgeContractError();
  try {
    const value = await invoke<unknown>(command, { request: normalized.data });
    const parsed = schema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.id !== normalized.data.id ||
      containsAbsolutePath(value)
    )
      throw new OpsBridgeContractError();
    return parsed.data;
  } catch (error) {
    if (error instanceof OpsBridgeContractError) throw error;
    const parsed = detailErrorSchema.safeParse(error);
    if (parsed.success) {
      if (parsed.data.error === "contract_invalid")
        throw new OpsBridgeContractError();
      throw new OpsDetailError(parsed.data.error);
    }
    throw error;
  }
}

export function getOpsResearchDetail(request: { id: string }) {
  return getOpsDetail(
    "ops_bridge_research_detail",
    request,
    opsResearchDetailSchema,
  );
}

export function getOpsRepositoryDetail(request: { id: string }) {
  return getOpsDetail(
    "ops_bridge_repository_detail",
    request,
    opsRepositoryDetailSchema,
  );
}

export type OpsDetailState<T> =
  | { status: "unavailable" }
  | { status: "contract_invalid" }
  | { status: "ready"; data: T };

function validPagedCapability(
  capabilities: OpsBridgeCapabilitiesV1,
  module: "research" | "repositories",
) {
  const capability = capabilities.modules?.find(
    (candidate) => candidate.name === module,
  );
  if (!capability) return null;
  if (
    "contract_invalid" in capability ||
    !capability.paged ||
    capability.collection_revision === undefined
  )
    return "invalid" as const;
  return capability;
}

export async function loadOpsResearchDetailState(
  id: string,
  capabilities: OpsBridgeCapabilitiesV1,
): Promise<OpsDetailState<OpsResearchDetailV1>> {
  const capability = validPagedCapability(capabilities, "research");
  if (capability === null) return { status: "unavailable" };
  if (capability === "invalid") {
    markOpsPagedModuleContractInvalid("research", capabilities);
    return { status: "contract_invalid" };
  }
  const key = capabilityKey(capability);
  prepareDormantState("research", key);
  const fencedState = () => {
    const state = getDormantOpsPageStates().research;
    if (state?.status === "contract_invalid")
      return { status: "contract_invalid" } as const;
    if (!isOpsPagedModuleGenerationCurrent("research", key))
      return { status: "unavailable" } as const;
    return null;
  };
  const beforeRequest = fencedState();
  if (beforeRequest) return beforeRequest;
  try {
    const data = await getOpsResearchDetail({ id });
    return fencedState() ?? { status: "ready", data };
  } catch (error) {
    const afterFailure = fencedState();
    if (afterFailure) return afterFailure;
    if (
      error instanceof OpsBridgeContractError ||
      (error instanceof OpsDetailError && error.code === "unavailable")
    ) {
      markOpsPagedModuleContractInvalid("research", capabilities);
      return { status: "contract_invalid" };
    }
    throw error;
  }
}

export async function loadOpsRepositoryDetailState(
  id: string,
  capabilities: OpsBridgeCapabilitiesV1,
): Promise<OpsDetailState<OpsRepositoryDetailV1>> {
  const capability = validPagedCapability(capabilities, "repositories");
  if (capability === null) return { status: "unavailable" };
  if (capability === "invalid") return { status: "contract_invalid" };
  try {
    return { status: "ready", data: await getOpsRepositoryDetail({ id }) };
  } catch (error) {
    if (error instanceof OpsDetailError && error.code === "unavailable")
      return { status: "unavailable" };
    if (error instanceof OpsBridgeContractError)
      return { status: "contract_invalid" };
    throw error;
  }
}

export async function loadOpsTeamsActivityState(
  request: Extract<OpsPageRequest, { module: "teams_activity" }>,
  capabilities: OpsBridgeCapabilitiesV1,
): Promise<
  | { status: "unavailable" }
  | { status: "contract_invalid" }
  | { status: "ready"; data: OpsPageV1<OpsTeamsActivityV1> }
> {
  const capability = capabilities.modules?.find(
    (candidate) => candidate.name === "teams_activity",
  );
  if (!capability) return { status: "unavailable" };
  if (
    "contract_invalid" in capability ||
    !capability.paged ||
    capability.collection_revision === undefined
  ) {
    markOpsPagedModuleContractInvalid("teams_activity", capabilities);
    return { status: "contract_invalid" };
  }
  const key = capabilityKey(capability);
  prepareDormantState("teams_activity", key);
  if (getDormantOpsPageStates().teams_activity?.status === "contract_invalid")
    return { status: "contract_invalid" };
  try {
    const state = {
      status: "ready",
      data: (await getOpsPage(
        request,
        capability.collection_revision,
      )) as OpsPageV1<OpsTeamsActivityV1>,
    } as const;
    setDormantState("teams_activity", key, state);
    return state;
  } catch (error) {
    if (
      error instanceof OpsBridgeContractError ||
      (error instanceof OpsPageError && error.code === "unavailable") ||
      (error instanceof OpsPageError && error.code === "invalid_cursor")
    ) {
      markOpsPagedModuleContractInvalid("teams_activity", capabilities);
      return { status: "contract_invalid" };
    }
    throw error;
  }
}
