import { z } from "zod";

import {
  count,
  positiveInteger,
  publicId,
  publicText,
  publicToken,
  safeInteger,
  unique,
  utcTimestamp,
} from "./opsDormantContracts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceAlias = z.string().regex(/^source:[a-f0-9]{32}$/u);
const comparisonSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const sourceStatus = z.enum([
  "ready",
  "not_configured",
  "unverified",
  "read_error",
]);
const approvalBoundary = z.enum([
  "none",
  "local_internal",
  "external_explicit",
  "forbidden",
]);

function responseBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? null
      : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return null;
  }
}

export function task5ResponseWithinLimit(value: unknown): boolean {
  const bytes = responseBytes(value);
  return bytes !== null && bytes <= MAX_RESPONSE_BYTES;
}

function boundedResponse<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, context) => {
    if (!task5ResponseWithinLimit(value))
      context.addIssue({ code: "custom", message: "response exceeds 2 MiB" });
  });
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
  }
  return leftBytes.length - rightBytes.length;
}

function timestampKey(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  return match ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}` : "";
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  context: { addIssue: (issue: { code: "custom"; message: string }) => void },
): void {
  if (new Set(values.map(key)).size !== values.length)
    context.addIssue({ code: "custom", message: "unique ids required" });
}

export const opsConnectionSchema = z
  .object({
    id: publicId,
    name: publicText(80),
    kind: z.enum([
      "hub",
      "orca",
      "codex",
      "claude_code",
      "microsoft_teams",
      "local_git",
      "github",
    ]),
    status: z.enum([
      "connected",
      "ready",
      "degraded",
      "not_configured",
      "initializing",
      "missing",
      "schema_mismatch",
      "locked",
      "read_error",
      "upstream_unavailable",
    ]),
    updated_at: utcTimestamp,
    observed_at: utcTimestamp,
    source_alias: sourceAlias,
    locator_label: publicText(80),
  })
  .strict();

export const opsConnectionsSchema = boundedResponse(
  z
    .array(opsConnectionSchema)
    .max(32)
    .superRefine((items, context) => {
      uniqueBy(items, (item) => item.id, context);
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1];
        const current = items[index];
        if (
          previous &&
          current &&
          (compareUtf8(previous.kind, current.kind) > 0 ||
            (previous.kind === current.kind &&
              compareUtf8(previous.id, current.id) > 0))
        )
          context.addIssue({
            code: "custom",
            message: "canonical order required",
          });
      }
    }),
);

export const opsTeamsActivitySchema = z
  .object({
    id: publicId,
    connection_id: publicId,
    activity_kind: z.enum([
      "channel_message",
      "chat_message",
      "meeting",
      "mention",
      "reply",
    ]),
    summary: publicText(280),
    observed_at: utcTimestamp,
    source_alias: sourceAlias,
    locator_label: publicText(80),
  })
  .strict();

export const opsTeamsActivityScopeSchema = z
  .object({
    connection: publicId,
    sort: z.literal("observed_at_desc"),
  })
  .strict();

const superpowersStateSchema = z
  .object({
    status: sourceStatus,
    version: publicText(64).nullable(),
    manifest_sha256: sha256.nullable(),
    observed_at: utcTimestamp.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const readyFields =
      value.version !== null &&
      value.manifest_sha256 !== null &&
      value.observed_at !== null;
    if ((value.status === "ready") !== readyFields)
      context.addIssue({
        code: "custom",
        message: "Superpowers readiness mismatch",
      });
  });

const routingStateSchema = z
  .object({
    status: sourceStatus,
    schema_version: z.literal(1).nullable(),
    source_sha256: sha256.nullable(),
    observed_at: utcTimestamp.nullable(),
    controller: publicToken.nullable(),
    allowed_models: unique(publicToken, 16),
    allowed_efforts: unique(publicToken, 16),
    max_active_sessions: safeInteger.min(1).max(64).nullable(),
    fallback: z.literal("forbidden").nullable(),
    approval_boundaries: unique(publicToken, 16),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "ready") {
      if (value.schema_version !== 1)
        context.addIssue({
          code: "custom",
          message: "routing schema required",
        });
      return;
    }
    if (
      value.controller !== null ||
      value.allowed_models.length !== 0 ||
      value.allowed_efforts.length !== 0 ||
      value.max_active_sessions !== null ||
      value.fallback !== null ||
      value.approval_boundaries.length !== 0
    )
      context.addIssue({
        code: "custom",
        message: "non-ready routing must be empty",
      });
  });

const planSchema = z
  .object({
    id: publicId,
    title: publicText(280),
    phase: z.enum([
      "spec",
      "plan",
      "implementation",
      "review",
      "verification",
      "release",
    ]),
    status: z.enum([
      "planned",
      "in_progress",
      "blocked",
      "complete",
      "unverified",
    ]),
    plan_sha256: sha256,
    ledger_sha256: sha256,
    evidence_count: count,
    review_finding_count: count,
    verification: z.enum(["verified", "unverified"]),
  })
  .strict();

const routeSchema = z
  .object({
    id: publicId,
    from: publicToken,
    to: publicToken,
    model: publicToken,
    effort: publicToken,
    enabled: z.boolean(),
    approval_boundary: approvalBoundary,
  })
  .strict();

function aggregateStatus(
  superpowers: z.infer<typeof sourceStatus>,
  routing: z.infer<typeof sourceStatus>,
) {
  if (superpowers === "read_error" || routing === "read_error")
    return "read_error";
  if (superpowers === "unverified" || routing === "unverified")
    return "unverified";
  if (superpowers === "ready" && routing === "ready") return "ready";
  if (superpowers === "not_configured" && routing === "not_configured")
    return "not_configured";
  return "partial";
}

export const opsWorkflowRoutingSchema = boundedResponse(
  z
    .object({
      status: z.enum([
        "ready",
        "partial",
        "not_configured",
        "unverified",
        "read_error",
      ]),
      superpowers: superpowersStateSchema,
      routing: routingStateSchema,
      plans: z.array(planSchema).max(64),
      routes: z.array(routeSchema).max(64),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.status !==
        aggregateStatus(value.superpowers.status, value.routing.status)
      )
        context.addIssue({
          code: "custom",
          message: "aggregate status mismatch",
        });
      uniqueBy(value.plans, (item) => item.id, context);
      uniqueBy(value.routes, (item) => item.id, context);
      if (value.superpowers.status !== "ready" && value.plans.length !== 0)
        context.addIssue({
          code: "custom",
          message: "plans require Superpowers",
        });
      if (value.routing.status !== "ready" && value.routes.length !== 0)
        context.addIssue({ code: "custom", message: "routes require routing" });
    }),
);

const readCapabilityOrder = ["snapshot", "events", "artifact"] as const;

export const opsSafetyPolicySchema = boundedResponse(
  z
    .object({
      policy_version: z.literal(1),
      read_capabilities: z.array(z.enum(readCapabilityOrder)).max(3),
      session_controls: z
        .object({
          drafts: z.tuple([z.literal("message"), z.literal("internal_task")]),
          transitions: z.tuple([
            z.literal("submit"),
            z.literal("approve"),
            z.literal("risk_confirm"),
            z.literal("reject"),
          ]),
        })
        .strict(),
      forbidden_actions: z.tuple([
        z.literal("external_delivery"),
        z.literal("provider_execution"),
        z.literal("teams_send"),
        z.literal("github_mutation"),
        z.literal("git_mutation"),
        z.literal("automatic_research"),
        z.literal("push"),
        z.literal("merge"),
        z.literal("publish"),
        z.literal("deploy"),
      ]),
      approval_boundaries: z
        .array(
          z
            .object({
              action: publicToken,
              boundary: approvalBoundary,
              requires_expected_revision: z.boolean(),
              requires_risk_confirmation: z.boolean(),
            })
            .strict(),
        )
        .max(16),
      control_session_ttl_seconds: z.literal(120),
    })
    .strict()
    .superRefine((value, context) => {
      const indexes = value.read_capabilities.map((item) =>
        readCapabilityOrder.indexOf(item),
      );
      if (
        indexes.some(
          (index, position) => position > 0 && index <= indexes[position - 1],
        )
      )
        context.addIssue({
          code: "custom",
          message: "ordered unique reads required",
        });
      uniqueBy(value.approval_boundaries, (item) => item.action, context);
    }),
);

export const opsResearchCardSchema = z
  .object({
    id: publicId,
    title: publicText(280),
    status: publicText(280),
    updated_at: utcTimestamp.optional(),
  })
  .strict();

export const opsRepositoryStatusSchema = z
  .object({
    id: publicId,
    name: publicText(280),
    branch: publicText(280),
    clean: z.boolean(),
    ahead: safeInteger.max(1_000_000).optional(),
    behind: safeInteger.max(1_000_000).optional(),
  })
  .strict();

const researchRepresentation = (representation: "markdown" | "json") =>
  z
    .object({
      artifact_id: publicId,
      version: positiveInteger,
      representation: z.literal(representation),
      sha256,
    })
    .strict();

export const opsResearchDetailSchema = boundedResponse(
  z
    .object({
      id: publicId,
      title: publicText(280),
      status: publicToken,
      release_version: positiveInteger,
      updated_at: utcTimestamp,
      review_receipt_id: publicId,
      reviewed_at: utcTimestamp,
      markdown: researchRepresentation("markdown"),
      json: researchRepresentation("json"),
    })
    .strict(),
);

const repositoryEvidenceSchema = z
  .object({
    id: publicId,
    command_alias: publicToken,
    status: z.enum(["verified", "unverified", "missing"]),
    observed_at: utcTimestamp,
    artifact_id: publicId,
    artifact_version: positiveInteger,
  })
  .strict();

export const opsRepositoryDetailSchema = boundedResponse(
  z
    .object({
      id: publicId,
      comparison_sha: comparisonSha,
      tracking_ref_observed_at: utcTimestamp,
      evidence: z.array(repositoryEvidenceSchema).max(64),
    })
    .strict()
    .superRefine((value, context) =>
      uniqueBy(value.evidence, (item) => item.id, context),
    ),
);

const pageEnvelope = <T extends z.ZodType>(item: T, maximum: number) =>
  boundedResponse(
    z
      .object({
        contract_version: z.literal(1),
        revision: safeInteger,
        generated_at: utcTimestamp,
        items: z.array(item).max(maximum),
        next_cursor: z.string().min(1).max(4096).nullable(),
      })
      .strict(),
  );

function parseRevisionBoundPage<T>(
  schema: z.ZodType<T>,
  value: unknown,
  expectedRevision: number,
): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const page = parsed.data as { revision: number };
  return page.revision === expectedRevision ? parsed.data : null;
}

export function parseOpsTeamsActivityPage(
  value: unknown,
  expectedRevision: number,
  scope: unknown,
) {
  const parsedScope = opsTeamsActivityScopeSchema.safeParse(scope);
  if (!parsedScope.success) return null;
  const schema = pageEnvelope(opsTeamsActivitySchema, 100).superRefine(
    (page, context) => {
      uniqueBy(page.items, (item) => item.id, context);
      if (
        page.items.some(
          (item) => item.connection_id !== parsedScope.data.connection,
        )
      )
        context.addIssue({
          code: "custom",
          message: "connection scope mismatch",
        });
      for (let index = 1; index < page.items.length; index += 1) {
        const previous = page.items[index - 1];
        const current = page.items[index];
        if (
          previous &&
          current &&
          (timestampKey(previous.observed_at) <
            timestampKey(current.observed_at) ||
            (timestampKey(previous.observed_at) ===
              timestampKey(current.observed_at) &&
              compareUtf8(previous.id, current.id) > 0))
        )
          context.addIssue({ code: "custom", message: "Teams order mismatch" });
      }
    },
  );
  return parseRevisionBoundPage(schema, value, expectedRevision);
}

export function parseOpsResearchPage(value: unknown, expectedRevision: number) {
  const schema = pageEnvelope(opsResearchCardSchema, 200).superRefine(
    (page, context) => uniqueBy(page.items, (item) => item.id, context),
  );
  return parseRevisionBoundPage(schema, value, expectedRevision);
}

export function parseOpsRepositoryPage(
  value: unknown,
  expectedRevision: number,
) {
  const schema = pageEnvelope(opsRepositoryStatusSchema, 200).superRefine(
    (page, context) => {
      uniqueBy(page.items, (item) => item.id, context);
      for (let index = 1; index < page.items.length; index += 1) {
        const previous = page.items[index - 1];
        const current = page.items[index];
        if (
          previous &&
          current &&
          (compareUtf8(previous.name, current.name) > 0 ||
            (previous.name === current.name &&
              compareUtf8(previous.id, current.id) > 0))
        )
          context.addIssue({
            code: "custom",
            message: "repository order mismatch",
          });
      }
    },
  );
  return parseRevisionBoundPage(schema, value, expectedRevision);
}

export type OpsConnectionV1 = z.infer<typeof opsConnectionSchema>;
export type OpsTeamsActivityV1 = z.infer<typeof opsTeamsActivitySchema>;
export type OpsWorkflowRoutingV1 = z.infer<typeof opsWorkflowRoutingSchema>;
export type OpsSafetyPolicyV1 = z.infer<typeof opsSafetyPolicySchema>;
export type OpsResearchCardV1 = z.infer<typeof opsResearchCardSchema>;
export type OpsRepositoryStatusV1 = z.infer<typeof opsRepositoryStatusSchema>;
export type OpsResearchDetailV1 = z.infer<typeof opsResearchDetailSchema>;
export type OpsRepositoryDetailV1 = z.infer<typeof opsRepositoryDetailSchema>;
