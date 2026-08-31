import {
  dormantPageItemSchemas,
  type DormantOpsModuleName,
} from "./opsDormantContracts";
import type { OpsBridgeCapabilitiesV1 } from "./types";

export type OpsPagedSafetyModule =
  | DormantOpsModuleName
  | "repositories"
  | "research"
  | "teams_activity";
export type OpsPagedSafetyState =
  | { status: "unavailable" }
  | { status: "contract_invalid" }
  | { status: "ready"; data?: unknown };
export type DormantOpsPageStates = Partial<
  Record<OpsPagedSafetyModule, OpsPagedSafetyState>
>;

type StateRecord = { capabilityKey: string; state: OpsPagedSafetyState };
const modules: OpsPagedSafetyModule[] = [
  ...(Object.keys(dormantPageItemSchemas) as DormantOpsModuleName[]),
  "research",
  "repositories",
  "teams_activity",
];
const records = new Map<OpsPagedSafetyModule, StateRecord>();
const authoritativeKeys = new Map<OpsPagedSafetyModule, string>();
const listeners = new Set<() => void>();
let snapshot: DormantOpsPageStates = {};

function publish(): void {
  snapshot = Object.fromEntries(
    [...records].map(([module, record]) => [module, record.state]),
  ) as DormantOpsPageStates;
  for (const listener of listeners) listener();
}

export function capabilityKey(
  capability:
    | NonNullable<OpsBridgeCapabilitiesV1["modules"]>[number]
    | undefined,
): string {
  if (!capability) return "absent";
  if (!capability.paged || capability.collection_revision === undefined)
    return "invalid";
  return `revision:${capability.collection_revision}`;
}

export function reconcileAuthoritativeDormantStates(
  capabilities: OpsBridgeCapabilitiesV1,
): void {
  let changed = false;
  for (const module of modules) {
    const key = capabilityKey(
      capabilities.modules?.find((candidate) => candidate.name === module),
    );
    authoritativeKeys.set(module, key);
    const current = records.get(module);
    if (current?.capabilityKey === key) continue;
    if (key === "invalid") {
      records.set(module, {
        capabilityKey: key,
        state: { status: "contract_invalid" },
      });
      changed = true;
    } else if (current) {
      records.delete(module);
      changed = true;
    }
  }
  if (changed) publish();
}

export function prepareDormantState(
  module: OpsPagedSafetyModule,
  key: string,
): void {
  const current = records.get(module);
  if (current?.capabilityKey === key) return;
  const authoritativeKey = authoritativeKeys.get(module);
  if (
    (authoritativeKey !== undefined && authoritativeKey !== key) ||
    current?.state.status === "contract_invalid"
  )
    return;
  records.set(module, { capabilityKey: key, state: { status: "unavailable" } });
  publish();
}

export function isOpsPagedModuleGenerationCurrent(
  module: OpsPagedSafetyModule,
  key: string,
): boolean {
  const authoritativeKey = authoritativeKeys.get(module);
  return (
    (authoritativeKey === undefined || authoritativeKey === key) &&
    records.get(module)?.capabilityKey === key
  );
}

export function setDormantState(
  module: OpsPagedSafetyModule,
  key: string,
  state: OpsPagedSafetyState,
): boolean {
  const current = records.get(module);
  if (!isOpsPagedModuleGenerationCurrent(module, key) || !current) return false;
  if (
    current.state.status === "contract_invalid" &&
    state.status !== "contract_invalid"
  )
    return false;
  records.set(module, { capabilityKey: key, state });
  publish();
  return true;
}

export function getDormantOpsPageStates(): DormantOpsPageStates {
  return snapshot;
}

export function subscribeDormantOpsPageStates(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetPagedModuleState(): void {
  authoritativeKeys.clear();
  if (records.size === 0) return;
  records.clear();
  publish();
}

export function markOpsPagedModuleContractInvalid(
  module: OpsPagedSafetyModule,
  capabilities: OpsBridgeCapabilitiesV1,
): void {
  const key = capabilityKey(
    capabilities.modules?.find((candidate) => candidate.name === module),
  );
  const authoritativeKey = authoritativeKeys.get(module);
  if (authoritativeKey !== undefined && authoritativeKey !== key) return;
  authoritativeKeys.set(module, key);
  prepareDormantState(module, key);
  setDormantState(module, key, { status: "contract_invalid" });
}
