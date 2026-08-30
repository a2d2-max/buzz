import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";

const originalWindow = globalThis.window;
const calls = [];
let responses = [];

function capabilities(modules) {
  return {
    contract_version: 1,
    reads: ["snapshot", "events", "artifact"],
    drafts: [],
    transitions: [],
    modules,
  };
}

function snapshot(overrides = {}) {
  return {
    contract_version: 1,
    revision: 1,
    generated_at: "2026-08-30T00:00:00Z",
    health: { hub: "ready", orca: "ready", codex: "ready" },
    room: {
      channels: [{ id: "all", project_id: null, label: "All", count: 0 }],
      selected_channel_id: "all",
      threads: [],
      selected_thread_id: null,
      messages: [],
      context: {
        work_item: null,
        provider_run: null,
        sessions: [],
        approvals: [],
        artifacts: [],
      },
    },
    session_tree: [],
    checklist: [],
    decisions: [],
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  responses = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push({ command, args });
        if (responses.length === 0)
          throw new Error(`unexpected invoke: ${command}`);
        const response = responses.shift();
        if (response?.reject !== undefined) throw response.reject;
        return response;
      },
    },
  };
});

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

const bridge = await import("./opsBridge.ts");
const task5 = await import("./opsTask5Contracts.ts");
const task5Bridge = await import("./opsTask5Bridge.ts");

const NOW = "2026-08-30T00:00:00.123456789Z";
const SHA = "a".repeat(64);
const SOURCE = `source:${"b".repeat(32)}`;

function connection(overrides = {}) {
  return {
    id: "connection:one",
    name: "Hub",
    kind: "hub",
    status: "ready",
    updated_at: NOW,
    observed_at: NOW,
    source_alias: SOURCE,
    locator_label: "Local Hub",
    ...overrides,
  };
}

function researchDetail(id = "research:one") {
  return {
    id,
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

function workflow(overrides = {}) {
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
    ...overrides,
  };
}

function safety(overrides = {}) {
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
    approval_boundaries: [
      {
        action: "provider_run",
        boundary: "forbidden",
        requires_expected_revision: true,
        requires_risk_confirmation: true,
      },
    ],
    control_session_ttl_seconds: 120,
    ...overrides,
  };
}

test("isolates a malformed advertised known capability but rejects an invalid unknown record globally", async () => {
  responses.push(
    capabilities([
      {
        name: "connections",
        schema_version: 1,
        paged: false,
        collection_revision: 7,
      },
      { name: "approvals", schema_version: 1, paged: false },
    ]),
    snapshot({
      approvals: [],
    }),
  );

  const isolated = await bridge.loadOpsSnapshot({});
  assert.deepEqual(isolated.module_states.connections, {
    status: "contract_invalid",
  });
  assert.equal(isolated.module_states.approvals.status, "ready");

  responses.push(
    capabilities([
      {
        name: "future_unknown_module",
        schema_version: 1,
        paged: false,
        collection_revision: 7,
      },
    ]),
  );
  await assert.rejects(
    bridge.getOpsCapabilities(),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
});

test("rejects duplicate capability names and accepts new Task 5 known names", async () => {
  responses.push(
    capabilities([
      { name: "safety_policy", schema_version: 1, paged: false },
      {
        name: "teams_activity",
        schema_version: 1,
        paged: true,
        collection_revision: Number.MAX_SAFE_INTEGER,
      },
    ]),
  );
  const parsed = await bridge.getOpsCapabilities();
  assert.deepEqual(
    parsed.modules?.map((module) => module.name),
    ["safety_policy", "teams_activity"],
  );

  responses.push(
    capabilities([
      { name: "connections", schema_version: 1, paged: false },
      { name: "connections", schema_version: 1, paged: false },
    ]),
  );
  await assert.rejects(
    bridge.getOpsCapabilities(),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
});

test("valid capability records with the wrong known topology are module-local invalid", async () => {
  responses.push(
    capabilities([
      {
        name: "connections",
        schema_version: 1,
        paged: true,
        collection_revision: 1,
      },
      { name: "teams_activity", schema_version: 1, paged: false },
    ]),
    snapshot({
      connections: [connection()],
      teams_activity: [],
    }),
  );
  const result = await bridge.loadOpsSnapshot({});
  assert.deepEqual(result.module_states.connections, {
    status: "contract_invalid",
  });
  assert.deepEqual(result.module_states.teams_activity, {
    status: "contract_invalid",
  });
});

test("Task 5 snapshot schemas enforce exact DTOs, canonical order, and source readiness", () => {
  assert.deepEqual(
    task5.opsConnectionsSchema.parse([connection()])[0],
    connection(),
  );
  for (const invalid of [
    connection({ extra: true }),
    connection({ kind: "future" }),
    connection({ source_alias: `${SOURCE}x` }),
    connection({ locator_label: "/Users/private/secret" }),
    connection({ locator_label: "Cafe\u0301" }),
    connection({ observed_at: "2026-02-30T00:00:00Z" }),
  ])
    assert.equal(
      task5.opsConnectionsSchema.safeParse([invalid]).success,
      false,
    );
  assert.equal(
    task5.opsConnectionsSchema.safeParse([
      connection({ kind: "orca", id: "connection:z" }),
      connection({ kind: "hub", id: "connection:a" }),
    ]).success,
    false,
  );
  assert.equal(
    task5.opsConnectionsSchema.safeParse(
      Array.from({ length: 33 }, (_, index) =>
        connection({ id: `connection:${index}` }),
      ),
    ).success,
    false,
  );

  assert.equal(
    task5.opsWorkflowRoutingSchema.safeParse(workflow()).success,
    true,
  );
  for (const invalid of [
    workflow({ status: "partial" }),
    workflow({
      superpowers: {
        status: "ready",
        version: null,
        manifest_sha256: SHA,
        observed_at: NOW,
      },
    }),
    workflow({
      status: "partial",
      superpowers: {
        status: "not_configured",
        version: null,
        manifest_sha256: null,
        observed_at: null,
      },
    }),
    workflow({
      routing: { ...workflow().routing, allowed_models: ["codex", "codex"] },
    }),
    workflow({ plans: [workflow().plans[0], workflow().plans[0]] }),
    workflow({ routes: [{ ...workflow().routes[0], model: "GPT-5" }] }),
  ])
    assert.equal(
      task5.opsWorkflowRoutingSchema.safeParse(invalid).success,
      false,
    );

  assert.equal(task5.opsSafetyPolicySchema.safeParse(safety()).success, true);
  for (const invalid of [
    safety({ read_capabilities: ["events", "snapshot"] }),
    safety({ forbidden_actions: [...safety().forbidden_actions].reverse() }),
    safety({ control_session_ttl_seconds: 121 }),
    safety({
      approval_boundaries: [
        safety().approval_boundaries[0],
        safety().approval_boundaries[0],
      ],
    }),
  ])
    assert.equal(task5.opsSafetyPolicySchema.safeParse(invalid).success, false);
});

test("Task 5 page and detail decoders bind scope, preserve overview shapes, and reject unsafe drift", () => {
  const teamsPage = {
    contract_version: 1,
    revision: 9,
    generated_at: NOW,
    items: [
      {
        id: "activity:one",
        connection_id: "connection:one",
        activity_kind: "mention",
        summary: "Mention",
        observed_at: NOW,
        source_alias: SOURCE,
        locator_label: "Channel",
      },
    ],
    next_cursor: null,
  };
  assert.equal(
    task5.parseOpsTeamsActivityPage(teamsPage, 9, {
      connection: "connection:one",
      sort: "observed_at_desc",
    })?.items[0].activity_kind,
    "mention",
  );
  for (const invalid of [
    { ...teamsPage, extra: true },
    {
      ...teamsPage,
      items: [{ ...teamsPage.items[0], connection_id: "connection:other" }],
    },
    {
      ...teamsPage,
      items: [{ ...teamsPage.items[0], summary: "x".repeat(281) }],
    },
    { ...teamsPage, next_cursor: "x".repeat(4097) },
  ])
    assert.equal(
      task5.parseOpsTeamsActivityPage(invalid, 9, {
        connection: "connection:one",
        sort: "observed_at_desc",
      }),
      null,
    );

  const researchPage = {
    contract_version: 1,
    revision: 2,
    generated_at: NOW,
    items: [{ id: "research:one", title: "Release", status: "ready" }],
    next_cursor: null,
  };
  const repositoryPage = {
    contract_version: 1,
    revision: 3,
    generated_at: NOW,
    items: [
      { id: "repository:one", name: "Buzz", branch: "main", clean: true },
    ],
    next_cursor: null,
  };
  assert.deepEqual(
    task5.parseOpsResearchPage(researchPage, 2)?.items,
    researchPage.items,
  );
  assert.deepEqual(
    task5.parseOpsRepositoryPage(repositoryPage, 3)?.items,
    repositoryPage.items,
  );
  assert.equal(
    task5.parseOpsResearchPage(
      {
        ...researchPage,
        items: [{ ...researchPage.items[0], created_at: NOW }],
      },
      2,
    ),
    null,
  );
  assert.equal(
    task5.parseOpsRepositoryPage(
      {
        ...repositoryPage,
        items: [{ ...repositoryPage.items[0], root: "/repo" }],
      },
      3,
    ),
    null,
  );
  assert.equal(
    task5.parseOpsResearchPage(
      {
        ...researchPage,
        items: [researchPage.items[0], researchPage.items[0]],
      },
      2,
    ),
    null,
  );
  assert.equal(
    task5.parseOpsRepositoryPage(
      {
        ...repositoryPage,
        items: [
          { id: "repository:z", name: "z", branch: "main", clean: true },
          { id: "repository:a", name: "a", branch: "main", clean: true },
        ],
      },
      3,
    ),
    null,
  );

  const researchDetail = {
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
  assert.equal(
    task5.opsResearchDetailSchema.safeParse(researchDetail).success,
    true,
  );
  assert.equal(
    task5.opsResearchDetailSchema.safeParse({
      ...researchDetail,
      markdown: { ...researchDetail.markdown, representation: "json" },
    }).success,
    false,
  );
  const repositoryDetail = {
    id: "repository:one",
    comparison_sha: "c".repeat(40),
    tracking_ref_observed_at: NOW,
    evidence: [
      {
        id: "evidence:one",
        command_alias: "test.unit",
        status: "verified",
        observed_at: NOW,
        artifact_id: "artifact:test",
        artifact_version: 1,
      },
    ],
  };
  assert.equal(
    task5.opsRepositoryDetailSchema.safeParse(repositoryDetail).success,
    true,
  );
  assert.equal(
    task5.opsRepositoryDetailSchema.safeParse({
      ...repositoryDetail,
      root: "/repo",
    }).success,
    false,
  );
});

test("Task 5 Zod boundary consumes the shared unsafe-text parity corpus", async () => {
  const corpus = JSON.parse(
    await readFile(
      new URL(
        "./testing/fixtures/dormant-public-value-corpus.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const locator_label of corpus.safe)
    assert.equal(
      task5.opsConnectionsSchema.safeParse([connection({ locator_label })])
        .success,
      true,
      locator_label,
    );
  for (const locator_label of corpus.unsafe)
    assert.equal(
      task5.opsConnectionsSchema.safeParse([connection({ locator_label })])
        .success,
      false,
      locator_label,
    );
});

test("Task 5 typed native requests use fixed Teams and detail commands and preserve unavailable", async () => {
  responses.push({
    contract_version: 1,
    revision: 4,
    generated_at: NOW,
    items: [],
    next_cursor: null,
  });
  await bridge.getOpsPage(
    {
      module: "teams_activity",
      scope: { connection: "connection:one", sort: "observed_at_desc" },
      page_size: 100,
      cursor: null,
    },
    4,
  );
  responses.push({ reject: { error: "unavailable" } });
  await assert.rejects(
    task5Bridge.getOpsResearchDetail({ id: "research:one" }),
    (error) =>
      error instanceof task5Bridge.OpsDetailError &&
      error.code === "unavailable",
  );
  responses.push({ reject: { error: "contract_invalid" } });
  await assert.rejects(
    task5Bridge.getOpsResearchDetail({ id: "research:two" }),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
  responses.push({
    id: "repository:one",
    comparison_sha: "c".repeat(40),
    tracking_ref_observed_at: NOW,
    evidence: [],
  });
  await task5Bridge.getOpsRepositoryDetail({ id: "repository:one" });
  responses.push(researchDetail("research:other"));
  await assert.rejects(
    task5Bridge.getOpsResearchDetail({ id: "research:requested" }),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
  responses.push({
    id: "repository:other",
    comparison_sha: "c".repeat(40),
    tracking_ref_observed_at: NOW,
    evidence: [],
  });
  await assert.rejects(
    task5Bridge.getOpsRepositoryDetail({ id: "repository:requested" }),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
  assert.deepEqual(
    calls.map(({ command }) => command),
    [
      "ops_bridge_page",
      "ops_bridge_research_detail",
      "ops_bridge_research_detail",
      "ops_bridge_repository_detail",
      "ops_bridge_research_detail",
      "ops_bridge_repository_detail",
    ],
  );
});

test("research detail failure is sticky module-invalid while repository detail failure stays local", async () => {
  bridge.resetDormantOpsPageStates();
  const advertised = capabilities([
    {
      name: "research",
      schema_version: 1,
      paged: true,
      collection_revision: 8,
    },
    {
      name: "repositories",
      schema_version: 1,
      paged: true,
      collection_revision: 9,
    },
  ]);
  responses.push({ reject: { error: "unavailable" } });
  assert.deepEqual(
    await task5Bridge.loadOpsResearchDetailState("research:one", advertised),
    { status: "contract_invalid" },
  );
  assert.deepEqual(bridge.getDormantOpsPageStates().research, {
    status: "contract_invalid",
  });
  const researchCalls = calls.length;
  responses.push(researchDetail());
  assert.deepEqual(
    await task5Bridge.loadOpsResearchDetailState("research:one", advertised),
    { status: "contract_invalid" },
  );
  assert.equal(calls.length, researchCalls);

  responses.push({ id: "repository:one", root: "/private/repo" });
  assert.deepEqual(
    await task5Bridge.loadOpsRepositoryDetailState(
      "repository:one",
      advertised,
    ),
    { status: "contract_invalid" },
  );
  assert.equal(bridge.getDormantOpsPageStates().repositories, undefined);
});

test("research detail fences a deferred old revision after the new revision wins", async () => {
  bridge.resetDormantOpsPageStates();
  let resolveOld;
  const oldResponse = new Promise((resolve) => {
    resolveOld = resolve;
  });
  responses.push(oldResponse, researchDetail("research:new"));
  const oldCapabilities = capabilities([
    {
      name: "research",
      schema_version: 1,
      paged: true,
      collection_revision: 8,
    },
  ]);
  const newCapabilities = capabilities([
    {
      name: "research",
      schema_version: 1,
      paged: true,
      collection_revision: 9,
    },
  ]);
  const oldResult = task5Bridge.loadOpsResearchDetailState(
    "research:old",
    oldCapabilities,
  );
  const newResult = await task5Bridge.loadOpsResearchDetailState(
    "research:new",
    newCapabilities,
  );
  resolveOld(researchDetail("research:old"));

  assert.equal(newResult.status, "ready");
  assert.deepEqual(await oldResult, { status: "unavailable" });
});

test("research detail ignores a deferred old-revision failure after new data wins", async () => {
  bridge.resetDormantOpsPageStates();
  let rejectOld;
  const oldResponse = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  responses.push(oldResponse, researchDetail("research:new"));
  const oldCapabilities = capabilities([
    {
      name: "research",
      schema_version: 1,
      paged: true,
      collection_revision: 8,
    },
  ]);
  const newCapabilities = capabilities([
    {
      name: "research",
      schema_version: 1,
      paged: true,
      collection_revision: 9,
    },
  ]);
  const oldResult = task5Bridge.loadOpsResearchDetailState(
    "research:old",
    oldCapabilities,
  );
  const newResult = await task5Bridge.loadOpsResearchDetailState(
    "research:new",
    newCapabilities,
  );
  rejectOld({ error: "contract_invalid" });

  assert.equal(newResult.status, "ready");
  assert.deepEqual(await oldResult, { status: "unavailable" });
  assert.notEqual(
    bridge.getDormantOpsPageStates().research?.status,
    "contract_invalid",
  );
});

test("snapshot envelope rejects revisions above the JavaScript-safe boundary", async () => {
  responses.push(snapshot({ revision: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(
    bridge.getOpsSnapshot({}),
    (error) => error instanceof bridge.OpsBridgeContractError,
  );
});

test("Teams page contract failure is revision-keyed and sticky until capability reset", async () => {
  bridge.resetDormantOpsPageStates();
  const advertised = capabilities([
    {
      name: "teams_activity",
      schema_version: 1,
      paged: true,
      collection_revision: 4,
    },
  ]);
  responses.push({
    contract_version: 1,
    revision: 4,
    generated_at: NOW,
    items: [
      {
        id: "activity:one",
        connection_id: "connection:other",
        activity_kind: "mention",
        summary: "Wrong source",
        observed_at: NOW,
        source_alias: SOURCE,
        locator_label: "Channel",
      },
    ],
    next_cursor: null,
  });
  const request = {
    module: "teams_activity",
    scope: { connection: "connection:one", sort: "observed_at_desc" },
    page_size: 100,
    cursor: null,
  };
  assert.deepEqual(
    await task5Bridge.loadOpsTeamsActivityState(request, advertised),
    {
      status: "contract_invalid",
    },
  );
  const callCount = calls.length;
  assert.deepEqual(
    await task5Bridge.loadOpsTeamsActivityState(request, advertised),
    {
      status: "contract_invalid",
    },
  );
  assert.equal(calls.length, callCount);
});

test("advertised Teams unavailable and native contract markers become sticky contract-invalid", async () => {
  bridge.resetDormantOpsPageStates();
  const advertised = capabilities([
    {
      name: "teams_activity",
      schema_version: 1,
      paged: true,
      collection_revision: 5,
    },
  ]);
  const request = {
    module: "teams_activity",
    scope: { connection: "connection:one", sort: "observed_at_desc" },
    page_size: 100,
    cursor: null,
  };
  responses.push({ reject: { error: "unavailable" } });
  assert.deepEqual(
    await task5Bridge.loadOpsTeamsActivityState(request, advertised),
    { status: "contract_invalid" },
  );

  bridge.resetDormantOpsPageStates();
  responses.push({ reject: { error: "contract_invalid" } });
  assert.deepEqual(
    await task5Bridge.loadOpsTeamsActivityState(request, advertised),
    { status: "contract_invalid" },
  );
});

test("Task 5 compatibility fixtures preserve guest reads, dormant peers, future modules, and isolation", async () => {
  const root = new URL("./testing/fixtures/", import.meta.url);
  const fixture = async (name) =>
    JSON.parse(await readFile(new URL(name, root), "utf8"));
  const oldHub = await fixture("old-hub-new-buzz-task5.json");
  const dormantHub = await fixture("new-hub-old-buzz-dormant-task5.json");
  const futureHub = await fixture("future-unknown-module-task5.json");
  const guest = await fixture("first-load-guest-task5.json");
  for (const value of [oldHub, dormantHub, futureHub, guest]) {
    responses.push(value.capabilities);
    const parsed = await bridge.getOpsCapabilities();
    assert.deepEqual(parsed.drafts, []);
    assert.deepEqual(parsed.transitions, []);
  }
  responses.push(
    ...(await fixture("malformed-known-isolation-task5.json")).responses,
  );
  const isolated = await bridge.loadOpsSnapshot({});
  assert.equal(isolated.module_states.connections.status, "contract_invalid");
  assert.equal(isolated.module_states.approvals.status, "ready");
});
