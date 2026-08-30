import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";

import * as task5 from "./opsTask5Contracts.ts";

const NOW = "2026-08-30T00:00:00.123456789Z";
const SHA = "a".repeat(64);
const legacyNames = [
  "timeline",
  "approvals",
  "artifacts",
  "connections",
  "workflow_routing",
  "research",
  "repositories",
  "work_items",
  "sessions",
  "checklist_items",
  "decisions",
  "approval_index",
  "evidence",
  "audit",
  "search",
];
const legacyModule = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    schema_version: z.literal(1),
    paged: z.boolean(),
    collection_revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict()
  .superRefine((module, context) => {
    if (module.paged && module.collection_revision === undefined)
      context.addIssue({
        code: "custom",
        message: "paged modules require collection revision",
      });
  });
const legacyCapabilities = z
  .object({
    contract_version: z.literal(1),
    reads: z.tuple([
      z.literal("snapshot"),
      z.literal("events"),
      z.literal("artifact"),
    ]),
    drafts: z.array(z.enum(["message", "internal_task", "provider_action"])),
    transitions: z.array(
      z.enum(["submit", "approve", "risk_confirm", "deliver", "reject"]),
    ),
    modules: z.array(legacyModule).optional(),
  })
  .strip();

function workflow() {
  return {
    status: "ready",
    superpowers: {
      status: "ready",
      version: "6.3.0",
      manifest_sha256: SHA,
      observed_at: NOW,
    },
    routing: {
      status: "ready",
      schema_version: 1,
      source_sha256: SHA,
      observed_at: NOW,
      controller: "codex",
      allowed_models: ["gpt-5.4"],
      allowed_efforts: ["high"],
      max_active_sessions: 4,
      fallback: "forbidden",
      approval_boundaries: ["external_explicit"],
    },
    plans: [
      {
        id: "plan:one",
        title: "Task 5",
        phase: "implementation",
        status: "in_progress",
        plan_sha256: SHA,
        ledger_sha256: SHA,
        evidence_count: 1,
        review_finding_count: 0,
        verification: "unverified",
      },
    ],
    routes: [
      {
        id: "route:one",
        from: "planner",
        to: "implementer",
        model: "gpt-5.4",
        effort: "high",
        enabled: true,
        approval_boundary: "local_internal",
      },
    ],
  };
}

function safety() {
  return {
    policy_version: 1,
    read_capabilities: ["snapshot", "events", "artifact"],
    session_controls: {
      drafts: ["message", "internal_task"],
      transitions: ["submit", "approve", "risk_confirm", "reject"],
    },
    forbidden_actions: [
      "external_delivery",
      "provider_execution",
      "teams_send",
      "github_mutation",
      "git_mutation",
      "automatic_research",
      "push",
      "merge",
      "publish",
      "deploy",
    ],
    approval_boundaries: [],
    control_session_ttl_seconds: 120,
  };
}

function researchDetail() {
  return {
    id: "research:one",
    title: "Release",
    status: "ready",
    release_version: 1,
    updated_at: NOW,
    review_receipt_id: "receipt:one",
    reviewed_at: NOW,
    markdown: {
      artifact_id: "artifact:markdown",
      version: 1,
      representation: "markdown",
      sha256: SHA,
    },
    json: {
      artifact_id: "artifact:json",
      version: 1,
      representation: "json",
      sha256: SHA,
    },
  };
}

test("new-Hub dormant capabilities execute through the frozen old-Buzz parser", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "./testing/fixtures/new-hub-old-buzz-dormant-task5.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const parsed = legacyCapabilities.parse(fixture.capabilities);
  const mounted = parsed.modules
    ?.filter((module) => legacyNames.includes(module.name))
    .map((module) => module.name);

  assert.deepEqual(mounted, ["repositories"]);
  assert.equal(
    parsed.modules?.some((module) =>
      ["safety_policy", "teams_activity"].includes(module.name),
    ),
    false,
  );
});

test("Task 5 Zod boundary matrix enforces frozen sizes, cardinalities, and full-match patterns", () => {
  assert.equal(
    task5.task5ResponseWithinLimit("a".repeat(2 * 1024 * 1024 - 2)),
    true,
  );
  assert.equal(
    task5.task5ResponseWithinLimit("a".repeat(2 * 1024 * 1024 - 1)),
    false,
  );

  const plan = workflow().plans[0];
  const route = workflow().routes[0];
  const workflowMax = workflow();
  workflowMax.plans = Array.from({ length: 64 }, (_, index) => ({
    ...plan,
    id: `plan:${index}`,
    evidence_count: index === 0 ? 10_000 : 1,
  }));
  workflowMax.routes = Array.from({ length: 64 }, (_, index) => ({
    ...route,
    id: `route:${index}`,
  }));
  for (const [field, prefix] of [
    ["allowed_models", "model"],
    ["allowed_efforts", "effort"],
    ["approval_boundaries", "boundary"],
  ])
    workflowMax.routing[field] = Array.from(
      { length: 16 },
      (_, index) => `${prefix}_${index}`,
    );
  workflowMax.routing.max_active_sessions = 64;
  assert.equal(
    task5.opsWorkflowRoutingSchema.safeParse(workflowMax).success,
    true,
  );

  const policyMax = safety();
  policyMax.approval_boundaries = Array.from({ length: 16 }, (_, index) => ({
    action: `action_${index}`,
    boundary: "forbidden",
    requires_expected_revision: true,
    requires_risk_confirmation: false,
  }));
  assert.equal(task5.opsSafetyPolicySchema.safeParse(policyMax).success, true);

  const repositoryMax = {
    id: "repository:one",
    comparison_sha: "c".repeat(40),
    tracking_ref_observed_at: NOW,
    evidence: Array.from({ length: 64 }, (_, index) => ({
      id: `evidence:${index}`,
      command_alias: "test.unit",
      status: "verified",
      observed_at: NOW,
      artifact_id: `artifact:${index}`,
      artifact_version: Number.MAX_SAFE_INTEGER,
    })),
  };
  assert.equal(
    task5.opsRepositoryDetailSchema.safeParse(repositoryMax).success,
    true,
  );
  const researchMax = researchDetail();
  researchMax.release_version = Number.MAX_SAFE_INTEGER;
  researchMax.markdown.version = Number.MAX_SAFE_INTEGER;
  assert.equal(
    task5.opsResearchDetailSchema.safeParse(researchMax).success,
    true,
  );

  const invalidCases = [
    [
      "plans over 64",
      task5.opsWorkflowRoutingSchema,
      {
        ...workflowMax,
        plans: [...workflowMax.plans, { ...plan, id: "plan:64" }],
      },
    ],
    [
      "routes over 64",
      task5.opsWorkflowRoutingSchema,
      {
        ...workflowMax,
        routes: [...workflowMax.routes, { ...route, id: "route:64" }],
      },
    ],
    ...["allowed_models", "allowed_efforts", "approval_boundaries"].map(
      (field) => {
        const value = workflow();
        value.routing[field] = Array.from(
          { length: 17 },
          (_, index) => `value_${index}`,
        );
        return [`${field} over 16`, task5.opsWorkflowRoutingSchema, value];
      },
    ),
    ...[0, 65].map((max_active_sessions) => {
      const value = workflow();
      value.routing.max_active_sessions = max_active_sessions;
      return ["active-session bound", task5.opsWorkflowRoutingSchema, value];
    }),
    [
      "count over 10000",
      task5.opsWorkflowRoutingSchema,
      { ...workflow(), plans: [{ ...plan, evidence_count: 10_001 }] },
    ],
    [
      "policy boundaries over 16",
      task5.opsSafetyPolicySchema,
      {
        ...policyMax,
        approval_boundaries: [
          ...policyMax.approval_boundaries,
          {
            action: "action_16",
            boundary: "forbidden",
            requires_expected_revision: true,
            requires_risk_confirmation: false,
          },
        ],
      },
    ],
    [
      "evidence over 64",
      task5.opsRepositoryDetailSchema,
      {
        ...repositoryMax,
        evidence: [
          ...repositoryMax.evidence,
          { ...repositoryMax.evidence[0], id: "evidence:64" },
        ],
      },
    ],
    ...[0, Number.MAX_SAFE_INTEGER + 1].map((release_version) => [
      "release-version bound",
      task5.opsResearchDetailSchema,
      { ...researchMax, release_version },
    ]),
  ];
  for (const [label, schema, value] of invalidCases)
    assert.equal(schema.safeParse(value).success, false, label);

  for (const invalidHash of [`x${SHA}`, `${SHA}x`, SHA.toUpperCase()])
    assert.equal(
      task5.opsResearchDetailSchema.safeParse({
        ...researchMax,
        markdown: { ...researchMax.markdown, sha256: invalidHash },
      }).success,
      false,
      invalidHash,
    );
  for (const invalidComparison of [
    `x${"c".repeat(40)}`,
    `${"c".repeat(40)}x`,
    "C".repeat(40),
  ])
    assert.equal(
      task5.opsRepositoryDetailSchema.safeParse({
        ...repositoryMax,
        comparison_sha: invalidComparison,
      }).success,
      false,
      invalidComparison,
    );
});
