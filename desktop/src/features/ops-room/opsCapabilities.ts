import { z } from "zod";

import { dormantModuleCapabilitySchema } from "./opsDormantContracts";

export const OPS_MODULE_NAMES = [
  "timeline",
  "approvals",
  "artifacts",
  "connections",
  "workflow_routing",
  "safety_policy",
  "research",
  "repositories",
  "teams_activity",
  "work_items",
  "sessions",
  "checklist_items",
  "decisions",
  "approval_index",
  "evidence",
  "audit",
  "search",
] as const;

export type OpsModuleName = (typeof OPS_MODULE_NAMES)[number];

export const OPS_MODULE_PAGED_TOPOLOGY: Record<OpsModuleName, boolean> = {
  timeline: true,
  approvals: false,
  artifacts: true,
  connections: false,
  workflow_routing: false,
  safety_policy: false,
  research: true,
  repositories: true,
  teams_activity: true,
  work_items: true,
  sessions: true,
  checklist_items: true,
  decisions: true,
  approval_index: true,
  evidence: true,
  audit: true,
  search: true,
};

const safeRevision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const draftCapabilitySchema = z.enum([
  "message",
  "internal_task",
  "provider_action",
]);
const transitionCapabilitySchema = z.enum([
  "submit",
  "approve",
  "risk_confirm",
  "deliver",
  "reject",
]);

export const opsModuleCapabilitySchema = z.discriminatedUnion("paged", [
  z
    .object({
      name: dormantModuleCapabilitySchema.options[0].shape.name,
      schema_version: z.literal(1),
      paged: z.literal(false),
    })
    .strict(),
  z
    .object({
      name: dormantModuleCapabilitySchema.options[1].shape.name,
      schema_version: z.literal(1),
      paged: z.literal(true),
      collection_revision: safeRevision,
    })
    .strict(),
]);

export type OpsValidModuleCapabilityV1 = z.infer<
  typeof opsModuleCapabilitySchema
>;
export type OpsInvalidKnownModuleCapabilityV1 = {
  name: OpsModuleName;
  schema_version: 1;
  paged: false;
  contract_invalid: true;
};
export type OpsModuleCapabilityV1 =
  | OpsValidModuleCapabilityV1
  | OpsInvalidKnownModuleCapabilityV1;

export interface OpsBridgeCapabilitiesV1 {
  contract_version: 1;
  reads: ["snapshot", "events", "artifact"];
  drafts: z.infer<typeof draftCapabilitySchema>[];
  transitions: z.infer<typeof transitionCapabilitySchema>[];
  modules?: OpsModuleCapabilityV1[];
}

const rawCapabilitiesSchema = z
  .object({
    contract_version: z.literal(1),
    reads: z.tuple([
      z.literal("snapshot"),
      z.literal("events"),
      z.literal("artifact"),
    ]),
    drafts: z.array(draftCapabilitySchema),
    transitions: z.array(transitionCapabilitySchema),
    modules: z.array(z.unknown()).optional(),
  })
  .strip();

export const opsCapabilitiesSchema = rawCapabilitiesSchema.transform(
  (value, context): OpsBridgeCapabilitiesV1 => {
    const names = new Set<string>();
    const modules: OpsModuleCapabilityV1[] = [];
    for (const candidate of value.modules ?? []) {
      const parsed = opsModuleCapabilitySchema.safeParse(candidate);
      let module: OpsModuleCapabilityV1;
      if (parsed.success) {
        module = parsed.data;
      } else if (
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Object.getPrototypeOf(candidate) === Object.prototype &&
        typeof (candidate as Record<string, unknown>).name === "string" &&
        OPS_MODULE_NAMES.includes(
          (candidate as Record<string, unknown>).name as OpsModuleName,
        )
      ) {
        module = {
          name: (candidate as Record<string, unknown>).name as OpsModuleName,
          schema_version: 1,
          paged: false,
          contract_invalid: true,
        };
      } else {
        context.addIssue({
          code: "custom",
          message: "invalid unknown module capability",
        });
        return z.NEVER;
      }
      if (names.has(module.name)) {
        context.addIssue({ code: "custom", message: "duplicate module name" });
        return z.NEVER;
      }
      names.add(module.name);
      modules.push(module);
    }
    return {
      contract_version: 1,
      reads: value.reads,
      drafts: value.drafts,
      transitions: value.transitions,
      ...(value.modules === undefined ? {} : { modules }),
    };
  },
);
