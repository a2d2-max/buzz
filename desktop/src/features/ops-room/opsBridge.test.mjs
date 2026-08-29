import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

const originalWindow = globalThis.window;
const calls = [];
let responses = [];

const capabilities = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
};

function validSnapshot(overrides = {}) {
  return {
    contract_version: 1,
    revision: 7,
    generated_at: "2026-08-29T00:00:00.000Z",
    health: { hub: "ready", orca: "ready", codex: "observed" },
    room: {
      channels: [{ id: "all", project_id: null, label: "전체", count: 1 }],
      selected_channel_id: "all",
      threads: [
        {
          id: "work:0123456789abcdef0123456789abcdef",
          type: "work",
          work_item_id: "work:0123456789abcdef0123456789abcdef",
          session_id: null,
          project_id: null,
          title: "Typed bridge",
          status: "in_progress",
          provider: "codex",
          updated_at: "2026-08-29T00:00:00.000Z",
          session_count: 1,
          approval_count: 0,
          artifact_count: 0,
        },
      ],
      selected_thread_id: "work:0123456789abcdef0123456789abcdef",
      messages: [
        {
          id: "event:0123456789abcdef0123456789abcdef",
          kind: "status",
          timestamp: "2026-08-29T00:00:00.000Z",
          role: "agent",
          author: "Codex",
          body: "Implementing typed bridge",
          details: { phase: "implementing" },
        },
      ],
      context: {
        work_item: null,
        provider_run: null,
        sessions: [],
        approvals: [],
        artifacts: [],
      },
      future_extension: { retained: true },
    },
    session_tree: [
      {
        id: "codex_direct:0123456789abcdef0123456789abcdef",
        source: "codex_direct",
        parent_session_id: null,
        work_item_id: "work:0123456789abcdef0123456789abcdef",
        title: "Direct Codex",
        activity: "implementing",
        health: "active",
        last_activity_at: "2026-08-29T00:00:00.000Z",
        child_ids: [],
      },
    ],
    checklist: [
      {
        id: "checklist:0123456789abcdef0123456789abcdef",
        title: "Validate contract",
        status: "in_progress",
      },
    ],
    decisions: [
      {
        id: "event:fedcba9876543210fedcba9876543210",
        queue: "agent_autonomous",
        source: "checklist",
        title: "Continue",
        question: "Continue implementation?",
      },
    ],
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
        if (responses.length === 0) {
          throw new Error(`unexpected invoke: ${command}`);
        }
        const response = responses.shift();
        if (response instanceof Error || typeof response === "string") {
          throw response;
        }
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

describe("native Ops bridge contract", () => {
  test("fetches and validates capabilities before the first snapshot with exact Tauri arguments", async () => {
    responses.push(capabilities, validSnapshot());

    const result = await bridge.loadOpsSnapshot({
      channel: "all",
      thread: null,
      limit: 100,
    });

    assert.deepEqual(calls, [
      { command: "ops_bridge_capabilities", args: null },
      {
        command: "ops_bridge_snapshot",
        args: {
          selection: { channel: "all", thread: null, limit: 100 },
        },
      },
    ]);
    assert.equal(result.contract_version, 1);
    assert.equal(result.room.extensions.future_extension.retained, true);
  });

  test("accepts an older version-one snapshot with no optional modules", async () => {
    responses.push(capabilities, validSnapshot());

    const result = await bridge.loadOpsSnapshot({});

    assert.equal(result.module_states.timeline.status, "unavailable");
    assert.equal(result.module_states.repositories.status, "unavailable");
  });

  test("marks an advertised optional module contract-invalid when its payload is absent or invalid", async () => {
    responses.push(
      {
        ...capabilities,
        modules: [{ name: "timeline", schema_version: 1, paged: false }],
      },
      validSnapshot(),
    );
    const absent = await bridge.loadOpsSnapshot({});
    assert.equal(absent.module_states.timeline.status, "contract_invalid");

    responses.push(
      {
        ...capabilities,
        modules: [{ name: "timeline", schema_version: 1, paged: false }],
      },
      validSnapshot({ timeline: [{ id: 1 }] }),
    );
    const invalid = await bridge.loadOpsSnapshot({});
    assert.equal(invalid.module_states.timeline.status, "contract_invalid");
  });

  test("accepts a valid advertised module and ignores unknown future modules", async () => {
    responses.push(
      {
        ...capabilities,
        modules: [
          { name: "timeline", schema_version: 1, paged: false },
          { name: "future_module", schema_version: 1, paged: true },
        ],
      },
      validSnapshot({
        timeline: [
          {
            id: "event:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            timestamp: "2026-08-29T00:00:01.000Z",
            kind: "status",
            author: "Orca",
            body: "Observed",
          },
        ],
      }),
    );

    const result = await bridge.loadOpsSnapshot({});

    assert.equal(result.module_states.timeline.status, "ready");
    assert.equal(result.module_states.timeline.data[0].author, "Orca");
  });

  test("rejects an invalid required session tree", async () => {
    responses.push(
      capabilities,
      validSnapshot({
        session_tree: [
          {
            id: "codex_direct:one",
            source: "shell",
            parent_session_id: null,
            work_item_id: null,
            title: "bad source",
            activity: null,
            health: "active",
            last_activity_at: null,
            child_ids: [],
          },
        ],
      }),
    );

    await assert.rejects(
      bridge.loadOpsSnapshot({}),
      (error) => error?.name === "OpsBridgeContractError",
    );
  });

  test("rejects work progress outside the canonical 0..1 contract", async () => {
    const snapshot = validSnapshot();
    snapshot.room.context.work_item = {
      id: "work:0123456789abcdef0123456789abcdef",
      project_id: null,
      title: "Invalid progress",
      status: "in_progress",
      progress: 1.2,
      last_activity_at: null,
      execution_provider: null,
      provider_model: null,
      provider_effort: null,
      revision: 1,
      updated_at: "2026-08-29T00:00:00.000Z",
    };
    responses.push(capabilities, snapshot);

    await assert.rejects(
      bridge.loadOpsSnapshot({}),
      (error) => error?.name === "OpsBridgeContractError",
    );
  });

  test("rejects absolute-path-looking public strings", async () => {
    const snapshot = validSnapshot();
    snapshot.room.threads[0].title = "/Users/alice/private/project";
    responses.push(capabilities, snapshot);

    await assert.rejects(
      bridge.loadOpsSnapshot({}),
      (error) => error?.name === "OpsBridgeContractError",
    );
  });

  test("rejects additional Unix workspace and system absolute paths", async () => {
    for (const path of [
      "/workspace/private/project",
      "/mnt/private/project",
      "/srv/private/project",
      "/usr/local/bin/private-tool",
      "/Library/Application Support/private",
      "/Applications/Buzz.app/private",
      "/System/Library/private",
      "/bin/private",
      "/sbin",
      "/lib/private",
      "/lib64/private",
      "/proc/self/environ",
      "/run/secrets/token",
      "/dev",
      "/sys/private",
      "/boot/private",
      "/media/private",
      "/nix/store/private",
      "/snap/private",
    ]) {
      const snapshot = validSnapshot();
      snapshot.room.threads[0].title = path;
      responses.push(capabilities, snapshot);
      await assert.rejects(
        bridge.loadOpsSnapshot({}),
        (error) => error?.name === "OpsBridgeContractError",
      );
    }
  });

  test("accepts slash-prefixed public routes and prose", async () => {
    for (const text of ["/api/v1", "/help", "/ship when ready"]) {
      const snapshot = validSnapshot();
      snapshot.room.threads[0].title = text;
      responses.push(capabilities, snapshot);
      const result = await bridge.loadOpsSnapshot({});
      assert.equal(result.room.threads[0].title, text);
    }
  });

  test("classifies a missing, non-numeric, or non-v1 version as version mismatch", async () => {
    for (const response of [
      { reads: [], drafts: [], transitions: [] },
      { contract_version: "1", reads: [], drafts: [], transitions: [] },
      { contract_version: 2, reads: [], drafts: [], transitions: [] },
    ]) {
      responses.push(response);
      await assert.rejects(
        bridge.getOpsCapabilities(),
        (error) => error?.name === "OpsBridgeVersionMismatchError",
      );
    }
  });

  test("rejects a version-one capability response missing a required read", async () => {
    responses.push({
      ...capabilities,
      reads: ["snapshot", "events"],
    });

    await assert.rejects(
      bridge.getOpsCapabilities(),
      (error) => error?.name === "OpsBridgeContractError",
    );
  });

  test("maps native config and token errors to not_configured", () => {
    for (const code of [
      "ops_bridge_invalid_config",
      "ops_bridge_token_unavailable",
      "ops_bridge_token_permissions",
      "ops_bridge_token_invalid",
    ]) {
      assert.equal(bridge.classifyOpsBridgeError(code), "not_configured");
    }
    assert.equal(
      bridge.classifyOpsBridgeError(new Error("ops_bridge_disconnected")),
      "disconnected",
    );
    assert.equal(
      bridge.classifyOpsBridgeError("ops_bridge_contract_mismatch"),
      "version_mismatch",
    );
  });

  test("starts the native watcher with the fixed command and no arguments", async () => {
    responses.push({ started: true });

    assert.deepEqual(await bridge.startOpsWatch(), { started: true });
    assert.deepEqual(calls, [
      { command: "ops_bridge_start_watch", args: null },
    ]);
  });
});

test("Ops snapshot query key is stable and defaults selection fields", () => {
  assert.deepEqual(bridge.opsSnapshotQueryKey({}), [
    "ops",
    "snapshot",
    null,
    null,
    100,
  ]);
  assert.deepEqual(
    bridge.opsSnapshotQueryKey({
      channel: "all",
      thread: "work:abc",
      limit: 25,
    }),
    ["ops", "snapshot", "all", "work:abc", 25],
  );
});
