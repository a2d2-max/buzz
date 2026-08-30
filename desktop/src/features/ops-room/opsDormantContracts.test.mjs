import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  dormantModuleCapabilitySchema,
  dormantPageRequestSchema,
  parseDormantPage,
} from "./opsDormantContracts.ts";

const originalWindow = globalThis.window;
const calls = [];
let responses = [];

const capabilities = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
};
const timestamp = "2026-08-30T00:00:00.123456789Z";

const cases = [
  {
    module: "work_items",
    scope: { sort: "last_activity_at_desc" },
    item: {
      id: "work:one",
      project_id: "project:one",
      title: "Work",
      status: "active",
      progress: 0.5,
      last_activity_at: timestamp,
      session_count: 1,
      approval_count: 2,
      artifact_count: 3,
    },
    invalid: [
      { status: "future" },
      { progress: Number.POSITIVE_INFINITY },
      { session_count: 10_001 },
      { project_id: null },
    ],
  },
  {
    module: "sessions",
    scope: { sort: "last_activity_at_desc" },
    item: {
      id: "codex_direct:one",
      source: "codex_direct",
      parent_session_id: null,
      work_item_id: null,
      title: "Session",
      activity: null,
      health: "context_unavailable",
      last_activity_at: null,
      child_count: 10_000,
    },
    invalid: [
      { health: "future" },
      { id: "codex_direct:one:two" },
      { id: "orca:one" },
      { child_count: 10_001 },
    ],
  },
  {
    module: "checklist_items",
    scope: { work_item: "work:one", sort: "order_asc_then_id" },
    item: {
      id: "checklist:one",
      work_item_id: "work:one",
      key: "key",
      title: "Checklist",
      order: 1_000_000,
      origin: "agent_plan",
      status: "in_progress",
      evidence_ids: ["evidence:one"],
      claimed_by_session_id: null,
      claimed_at: null,
      stage: null,
      next_action: "Continue",
      depends_on: ["checklist:zero"],
      updated_at: timestamp,
      revision: 1,
    },
    invalid: [
      { origin: "future" },
      { evidence_ids: ["evidence:one", "evidence:one"] },
      { work_item_id: "work:other" },
      { revision: 0 },
    ],
  },
  {
    module: "decisions",
    scope: { sort: "updated_at_desc" },
    item: {
      id: "decision:one",
      work_item_id: null,
      source: "checklist",
      source_id: "checklist:one",
      title: "Decision",
      question: "Continue?",
      options: ["Yes", "No"],
      needed_input: null,
      impact: "Bounded",
      queue: "user_decision",
      status: "open",
      updated_at: timestamp,
      revision: 1,
    },
    invalid: [
      { queue: "future" },
      { options: ["Yes", "Yes"] },
      { needed_input: 1 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
    ],
  },
  {
    module: "approval_index",
    scope: { sort: "updated_at_desc" },
    item: {
      id: "approval:one",
      work_item_id: "work:one",
      action_kind: "provider_interrupt",
      status: "awaiting_risk_confirm",
      hold_reason: null,
      risk_class: ["session_stop"],
      updated_at: timestamp,
      revision: 1,
    },
    invalid: [
      { status: "future" },
      { action_kind: "deliver" },
      { risk_class: ["session_stop", "session_stop"] },
      { revision: 0 },
    ],
  },
  {
    module: "evidence",
    scope: { sort: "observed_at_desc" },
    item: {
      id: "evidence:one",
      work_item_id: "work:one",
      kind: "test_report",
      status: "verified",
      observed_at: timestamp,
      artifact_id: "artifact:one",
      artifact_version: 1,
    },
    invalid: [
      { kind: "future" },
      { status: "trusted" },
      { artifact_version: null },
      { artifact_version: 0 },
    ],
  },
  {
    module: "audit",
    scope: { sort: "observed_at_desc" },
    item: {
      id: "audit:one",
      work_item_id: null,
      kind: "adapter.status",
      summary: "Safe summary",
      observed_at: timestamp,
    },
    invalid: [
      { kind: "Adapter Status" },
      { kind: "a".repeat(65) },
      { summary: "" },
      { observed_at: "2026-02-30T00:00:00Z" },
    ],
  },
  {
    module: "search",
    scope: {
      q: "Café",
      kind: "audit",
      work: "work:one",
      sort: "rank_desc_then_observed_at_desc",
    },
    item: {
      id: "search:one",
      kind: "research",
      title: "Result",
      snippet: "Safe excerpt",
      observed_at: timestamp,
      work_item_id: null,
    },
    invalid: [
      { kind: "raw_message" },
      { title: "" },
      { snippet: "x".repeat(281) },
      { work_item_id: 1 },
    ],
  },
];

function page(item, overrides = {}) {
  return {
    contract_version: 1,
    revision: 3,
    generated_at: timestamp,
    items: [item],
    next_cursor: null,
    ...overrides,
  };
}

beforeEach(() => {
  bridge.resetDormantOpsPageStates();
  calls.length = 0;
  responses = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push({ command, args });
        const response = await responses.shift();
        if (response?.reject !== undefined) throw response.reject;
        if (response === undefined)
          throw new Error(`unexpected invoke: ${command}`);
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
const publicValueCorpus = JSON.parse(
  await readFile(
    new URL(
      "./testing/fixtures/dormant-public-value-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("dormant Ops DTO, request, and envelope contracts", () => {
  test("accepts every exact DTO and rejects unknown fields, closed values, null drift, and bounds", () => {
    for (const { module, scope, item, invalid } of cases) {
      assert.ok(parseDormantPage(page(item), module, 3, scope), module);
      assert.equal(
        parseDormantPage(page({ ...item, extra: true }), module, 3, scope),
        null,
        `${module}: item unknown field`,
      );
      for (const patch of invalid) {
        assert.equal(
          parseDormantPage(page({ ...item, ...patch }), module, 3, scope),
          null,
          `${module}: ${JSON.stringify(patch)}`,
        );
      }
    }
  });

  test("enforces the exact bounded page envelope for every DTO", () => {
    for (const { module, scope, item } of cases) {
      for (const invalidPage of [
        page(item, { extra: true }),
        page(item, { contract_version: 2 }),
        page(item, { revision: Number.MAX_SAFE_INTEGER + 1 }),
        page(item, { generated_at: "2026-02-30T00:00:00Z" }),
        page(item, { items: Array(201).fill(item) }),
        page(item, { next_cursor: "" }),
        page(item, { next_cursor: "x".repeat(4097) }),
      ]) {
        assert.equal(
          parseDormantPage(invalidPage, module, 3, scope),
          null,
          module,
        );
      }
    }
  });

  test("enforces exact q, kind, work, sort, cursor, and page-size requests for all eight modules", () => {
    for (const { module, scope } of cases) {
      const valid = { module, scope, page_size: 200, cursor: null };
      assert.equal(
        dormantPageRequestSchema.safeParse(valid).success,
        true,
        module,
      );
      for (const invalid of [
        { ...valid, extra: true },
        { ...valid, page_size: 0 },
        { ...valid, page_size: 201 },
        { ...valid, cursor: "" },
        { ...valid, scope: { ...scope, extra: true } },
        { ...valid, scope: { ...scope, sort: "future_sort" } },
      ]) {
        assert.equal(
          dormantPageRequestSchema.safeParse(invalid).success,
          false,
          module,
        );
      }
    }
    const search = cases.at(-1);
    for (const scope of [
      { ...search.scope, q: "" },
      { ...search.scope, q: "x".repeat(101) },
      { ...search.scope, q: "bad\uFFFDquery" },
      { ...search.scope, kind: "raw_message" },
      { ...search.scope, work: "/private/work" },
    ]) {
      assert.equal(
        dormantPageRequestSchema.safeParse({
          module: "search",
          scope,
          page_size: 100,
          cursor: null,
        }).success,
        false,
      );
    }
  });
});

describe("dormant Ops public-value parity", () => {
  test("rejects the full unsafe text matrix in DTOs and search while allowing ordinary HTTPS", () => {
    const work = cases[0];
    for (const value of [...publicValueCorpus.unsafe, "bad\ud800"]) {
      assert.equal(
        parseDormantPage(
          page({ ...work.item, title: value }),
          work.module,
          3,
          work.scope,
        ),
        null,
        value,
      );
      assert.equal(
        dormantPageRequestSchema.safeParse({
          module: "search",
          scope: { q: value, sort: "rank_desc_then_observed_at_desc" },
          page_size: 100,
          cursor: null,
        }).success,
        false,
        value,
      );
    }
    for (const value of publicValueCorpus.safe) {
      assert.ok(
        parseDormantPage(
          page({ ...work.item, title: value }),
          work.module,
          3,
          work.scope,
        ),
      );
    }
  });

  test("accepts only exact calendar-valid UTC Z timestamps and exact session suffixes", () => {
    const work = cases[0];
    for (const value of [
      "2026-08-30T00:00:00Z",
      "2024-02-29T23:59:59.123456789Z",
    ]) {
      assert.ok(
        parseDormantPage(
          page({ ...work.item, last_activity_at: value }),
          work.module,
          3,
          work.scope,
        ),
      );
    }
    for (const value of [
      "2026-02-30T00:00:00Z",
      "2026-08-30T00:00:60Z",
      "2026-08-30T00:00:00+00:00",
      "2026-08-30T00:00:00.Z",
      "２０２６-08-30T00:00:00Z",
    ]) {
      assert.equal(
        parseDormantPage(
          page({ ...work.item, last_activity_at: value }),
          work.module,
          3,
          work.scope,
        ),
        null,
      );
    }
    for (const value of [
      "0000-01-01T00:00:00Z",
      "0001-01-01T00:00:00Z",
      "0099-12-31T23:59:59.123456789Z",
    ]) {
      assert.ok(
        parseDormantPage(
          page({ ...work.item, last_activity_at: value }),
          work.module,
          3,
          work.scope,
        ),
        value,
      );
    }
    const session = cases[1];
    for (const id of [
      "codex_direct:",
      "codex_direct:one:two",
      "codex_direct:-one",
    ]) {
      assert.equal(
        parseDormantPage(
          page({ ...session.item, id }),
          session.module,
          3,
          session.scope,
        ),
        null,
        id,
      );
    }
  });
});

describe("dormant Ops capability and state compatibility", () => {
  test("keeps capability records closed, NFC/token bounded, schema-one, and safely paged", () => {
    const valid = {
      name: "work_items",
      schema_version: 1,
      paged: true,
      collection_revision: 0,
    };
    assert.equal(dormantModuleCapabilitySchema.safeParse(valid).success, true);
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, name: "WorkItems" },
      { ...valid, name: "a".repeat(65) },
      { ...valid, name: "cafe\u0301" },
      { ...valid, schema_version: 2 },
      { ...valid, collection_revision: Number.MAX_SAFE_INTEGER + 1 },
      { name: "work_items", schema_version: 1, paged: true },
    ])
      assert.equal(
        dormantModuleCapabilitySchema.safeParse(invalid).success,
        false,
      );
  });

  test("accepts top-level additions, rejects duplicates, and filters valid future modules via fixtures", async () => {
    const root = new URL("./testing/fixtures/", import.meta.url);
    for (const file of [
      "old-hub-new-buzz-task3.json",
      "new-hub-old-buzz-dormant-task3.json",
      "future-hub-current-buzz-task3.json",
    ]) {
      const fixture = JSON.parse(await readFile(new URL(file, root), "utf8"));
      responses.push({ ...fixture, future_top_level: { ignored: true } });
      assert.deepEqual((await bridge.getOpsCapabilities()).modules, []);
    }
    responses.push({
      ...capabilities,
      modules: [
        {
          name: "work_items",
          schema_version: 1,
          paged: true,
          collection_revision: 1,
        },
        {
          name: "work_items",
          schema_version: 1,
          paged: true,
          collection_revision: 1,
        },
      ],
    });
    await assert.rejects(bridge.getOpsCapabilities(), {
      name: "OpsBridgeContractError",
    });
  });

  test("maps absent, invalid topology, ready, malformed, and exact unavailable module states locally", async () => {
    const request = {
      module: "work_items",
      scope: { sort: "last_activity_at_desc" },
      page_size: 100,
      cursor: null,
    };
    assert.deepEqual(
      await bridge.loadDormantOpsModuleState(request, capabilities),
      { status: "unavailable" },
    );
    assert.equal(calls.length, 0);

    for (const capability of [
      { name: "work_items", schema_version: 1, paged: false },
      { name: "work_items", schema_version: 1, paged: true },
    ]) {
      assert.deepEqual(
        await bridge.loadDormantOpsModuleState(request, {
          ...capabilities,
          modules: [capability],
        }),
        { status: "contract_invalid" },
      );
      assert.equal(calls.length, 0);
    }

    responses.push(page(cases[0].item));
    assert.equal(
      (
        await bridge.loadDormantOpsModuleState(request, {
          ...capabilities,
          modules: [
            {
              name: "work_items",
              schema_version: 1,
              paged: true,
              collection_revision: 3,
            },
          ],
        })
      ).status,
      "ready",
    );
    responses.push(page({ ...cases[0].item, extra: true }));
    assert.deepEqual(
      await bridge.loadDormantOpsModuleState(request, {
        ...capabilities,
        modules: [
          {
            name: "work_items",
            schema_version: 1,
            paged: true,
            collection_revision: 3,
          },
        ],
      }),
      { status: "contract_invalid" },
    );
    const revisionFourCapabilities = {
      ...capabilities,
      modules: [
        {
          name: "work_items",
          schema_version: 1,
          paged: true,
          collection_revision: 4,
        },
      ],
    };
    responses.push(revisionFourCapabilities);
    await bridge.getOpsCapabilities();
    assert.equal(bridge.getDormantOpsPageStates().work_items, undefined);
    responses.push({ reject: { error: "unavailable" } });
    assert.deepEqual(
      await bridge.loadDormantOpsModuleState(request, revisionFourCapabilities),
      { status: "unavailable" },
    );
    assert.deepEqual(bridge.getDormantOpsPageStates().work_items, {
      status: "unavailable",
    });
  });

  test("keeps same-revision contract-invalid sticky across sequential and deferred results", async () => {
    const requestOne = {
      module: "checklist_items",
      scope: { work_item: "work:one", sort: "order_asc_then_id" },
      page_size: 100,
      cursor: null,
    };
    const requestTwo = {
      ...requestOne,
      scope: { work_item: "work:two", sort: "order_asc_then_id" },
    };
    const itemTwo = {
      ...cases[2].item,
      id: "checklist:two",
      work_item_id: "work:two",
    };
    const advertised = {
      ...capabilities,
      modules: [
        {
          name: "checklist_items",
          schema_version: 1,
          paged: true,
          collection_revision: 3,
        },
      ],
    };

    responses.push(page({ ...cases[2].item, extra: true }), page(itemTwo));
    assert.equal(
      (await bridge.loadDormantOpsModuleState(requestOne, advertised)).status,
      "contract_invalid",
    );
    assert.equal(
      (await bridge.loadDormantOpsModuleState(requestTwo, advertised)).status,
      "ready",
    );
    assert.deepEqual(bridge.getDormantOpsPageStates().checklist_items, {
      status: "contract_invalid",
    });
    responses.push({ reject: { error: "unavailable" } });
    assert.equal(
      (await bridge.loadDormantOpsModuleState(requestTwo, advertised)).status,
      "unavailable",
    );
    assert.deepEqual(bridge.getDormantOpsPageStates().checklist_items, {
      status: "contract_invalid",
    });

    let resolveReady;
    const deferredReady = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const revisionFour = {
      ...advertised,
      modules: [{ ...advertised.modules[0], collection_revision: 4 }],
    };
    responses.push(revisionFour);
    await bridge.getOpsCapabilities();
    responses.push(deferredReady, page({ ...cases[2].item, extra: true }));
    const pendingReady = bridge.loadDormantOpsModuleState(
      requestTwo,
      revisionFour,
    );
    assert.deepEqual(bridge.getDormantOpsPageStates().checklist_items, {
      status: "unavailable",
    });
    assert.equal(
      (await bridge.loadDormantOpsModuleState(requestOne, revisionFour)).status,
      "contract_invalid",
    );
    resolveReady(page(itemTwo, { revision: 4 }));
    assert.equal((await pendingReady).status, "ready");
    assert.deepEqual(bridge.getDormantOpsPageStates().checklist_items, {
      status: "contract_invalid",
    });

    let resolveUnavailable;
    const deferredUnavailable = new Promise((resolve) => {
      resolveUnavailable = resolve;
    });
    const revisionFive = {
      ...advertised,
      modules: [{ ...advertised.modules[0], collection_revision: 5 }],
    };
    responses.push(revisionFive);
    await bridge.getOpsCapabilities();
    responses.push(
      deferredUnavailable,
      page({ ...cases[2].item, extra: true }),
    );
    const pendingUnavailable = bridge.loadDormantOpsModuleState(
      requestTwo,
      revisionFive,
    );
    assert.equal(
      (await bridge.loadDormantOpsModuleState(requestOne, revisionFive)).status,
      "contract_invalid",
    );
    resolveUnavailable({ reject: { error: "unavailable" } });
    assert.equal((await pendingUnavailable).status, "unavailable");
    assert.deepEqual(bridge.getDormantOpsPageStates().checklist_items, {
      status: "contract_invalid",
    });

    responses.push({ ...capabilities, modules: [] });
    await bridge.getOpsCapabilities();
    assert.equal(bridge.getDormantOpsPageStates().checklist_items, undefined);
  });

  test("only the latest authoritative capability probe may reset an invalid revision", async () => {
    const request = {
      module: "work_items",
      scope: { sort: "last_activity_at_desc" },
      page_size: 100,
      cursor: null,
    };
    const revisionFive = {
      ...capabilities,
      modules: [
        {
          name: "work_items",
          schema_version: 1,
          paged: true,
          collection_revision: 5,
        },
      ],
    };
    const staleRevisionFour = {
      ...revisionFive,
      modules: [{ ...revisionFive.modules[0], collection_revision: 4 }],
    };

    for (const [label, staleCapabilities, authoritativeClear] of [
      [
        "lower revision",
        staleRevisionFour,
        {
          ...revisionFive,
          modules: [{ ...revisionFive.modules[0], collection_revision: 6 }],
        },
      ],
      ["absence", { ...capabilities, modules: [] }, capabilities],
    ]) {
      bridge.resetDormantOpsPageStates();
      responses = [];
      let resolveStale;
      const staleResponse = new Promise((resolve) => {
        resolveStale = resolve;
      });
      responses.push(staleResponse, revisionFive);
      const pendingStaleProbe = bridge.getOpsCapabilities();
      const latestCapabilities = await bridge.getOpsCapabilities();

      responses.push(page({ ...cases[0].item, extra: true }, { revision: 5 }));
      assert.equal(
        (await bridge.loadDormantOpsModuleState(request, latestCapabilities))
          .status,
        "contract_invalid",
        label,
      );

      if (label === "lower revision") {
        responses.push(page(cases[0].item, { revision: 4 }));
        assert.equal(
          (await bridge.loadDormantOpsModuleState(request, staleRevisionFour))
            .status,
          "ready",
        );
        assert.deepEqual(bridge.getDormantOpsPageStates().work_items, {
          status: "contract_invalid",
        });
      } else {
        assert.deepEqual(
          await bridge.loadDormantOpsModuleState(request, staleCapabilities),
          { status: "unavailable" },
        );
      }

      resolveStale(staleCapabilities);
      await pendingStaleProbe;
      assert.deepEqual(
        bridge.getDormantOpsPageStates().work_items,
        { status: "contract_invalid" },
        label,
      );

      responses.push(authoritativeClear);
      await bridge.getOpsCapabilities();
      assert.equal(
        bridge.getDormantOpsPageStates().work_items,
        undefined,
        label,
      );
    }
  });
});
