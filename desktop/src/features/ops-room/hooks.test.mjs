import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/#/ops",
});
const calls = [];
const commandResponses = new Map();
const callbacks = new Map();
let nextCallbackId = 1;
let focused = true;
let fakeTimersEnabled = false;

const capabilities = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
};

function snapshot(revision = 1, overrides = {}) {
  return {
    contract_version: 1,
    revision,
    generated_at: `2026-08-29T00:00:0${revision}.000Z`,
    health: { hub: "ready", orca: "ready", codex: "ready" },
    room: {
      channels: [{ id: "all", project_id: null, label: "전체", count: 0 }],
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
    event_sequence: String(revision),
    ...overrides,
  };
}

function queue(command, ...values) {
  commandResponses.set(command, values);
}

function nextResponse(command) {
  const values = commandResponses.get(command) ?? [];
  if (values.length === 0) {
    throw new Error(`unexpected invoke: ${command}`);
  }
  const value = values.shift();
  if (value?.reject !== undefined) throw value.reject;
  if (value instanceof Error || typeof value === "string") throw value;
  return value;
}

before(() => {
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  Object.defineProperty(dom.window.document, "hasFocus", {
    configurable: true,
    value: () => focused,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    isTauri: true,
    window: dom.window,
  });
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "plugin:event|listen") {
        return commandResponses.has(command) ? nextResponse(command) : 41;
      }
      if (command === "plugin:event|unlisten") return null;
      if (command === "ops_bridge_stop_watch") return null;
      if (command === "ops_bridge_start_watch") {
        const response = await nextResponse(command);
        return {
          connection_generation: 1,
          sync_required: false,
          anchor_sequence: null,
          ...response,
        };
      }
      return nextResponse(command);
    },
    transformCallback(callback) {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };
});

beforeEach(() => {
  calls.length = 0;
  commandResponses.clear();
  callbacks.clear();
  focused = true;
  fakeTimersEnabled = false;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  await resetOpsWatchManager();
  resetDormantOpsPageStates();
  mock.timers.reset();
});

after(() => dom.window.close());

const { opsMutationsDisabled, resetOpsWatchManager, useOpsSnapshot } =
  await import("./hooks.ts");
const {
  getOpsCapabilities,
  loadDormantOpsModuleState,
  resetDormantOpsPageStates,
} = await import("./opsBridge.ts");

test("mutations stay disabled for every non-ready lifecycle and any invalid optional module", () => {
  const valid = {
    module_states: {
      timeline: { status: "ready", data: [] },
      approvals: { status: "unavailable" },
      artifacts: { status: "unavailable" },
      connections: { status: "unavailable" },
      workflow_routing: { status: "unavailable" },
      research: { status: "unavailable" },
      repositories: { status: "unavailable" },
    },
  };
  for (const state of [
    "loading",
    "stale",
    "disconnected",
    "not_configured",
    "version_mismatch",
    "contract_invalid",
  ]) {
    assert.equal(opsMutationsDisabled(state, valid), true, state);
  }
  assert.equal(opsMutationsDisabled("ready", valid), false);
  assert.equal(
    opsMutationsDisabled("ready", {
      ...valid,
      module_states: {
        ...valid.module_states,
        research: { status: "contract_invalid" },
      },
    }),
    true,
  );
  const pagedStates = {
    work_items: { status: "ready", data: { items: [] } },
    search: { status: "contract_invalid" },
  };
  assert.equal(opsMutationsDisabled("ready", valid, pagedStates), true);
  assert.equal(
    opsMutationsDisabled("ready", valid, {
      work_items: { status: "ready", data: { items: [] } },
    }),
    false,
  );
});

test("a malformed paged module disables the real hook while retaining unrelated reads", async () => {
  const pagedCapabilities = {
    ...capabilities,
    modules: [
      {
        name: "work_items",
        schema_version: 1,
        paged: true,
        collection_revision: 3,
      },
    ],
  };
  queue("ops_bridge_capabilities", pagedCapabilities, pagedCapabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });
  queue(
    "ops_bridge_page",
    {
      contract_version: 1,
      revision: 3,
      generated_at: "2026-08-30T00:00:00Z",
      items: [{ extra: true }],
      next_cursor: null,
    },
    {
      contract_version: 1,
      revision: 3,
      generated_at: "2026-08-30T00:00:00Z",
      items: [],
      next_cursor: null,
    },
    { reject: { error: "unavailable" } },
  );

  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  assert.equal(view.result.current.mutationsDisabled, false);
  await act(async () => {
    const state = await loadDormantOpsModuleState(
      {
        module: "work_items",
        scope: { sort: "last_activity_at_desc" },
        page_size: 100,
        cursor: null,
      },
      pagedCapabilities,
    );
    assert.deepEqual(state, { status: "contract_invalid" });
  });
  assert.equal(view.result.current.mutationsDisabled, true);
  assert.equal(view.result.current.snapshot.revision, 2);
  assert.equal(view.result.current.state, "ready");
  await act(async () => {
    assert.equal(
      (
        await loadDormantOpsModuleState(
          {
            module: "work_items",
            scope: { sort: "last_activity_at_desc" },
            page_size: 100,
            cursor: null,
          },
          pagedCapabilities,
        )
      ).status,
      "ready",
    );
  });
  assert.equal(view.result.current.mutationsDisabled, true);
  await act(async () => {
    assert.equal(
      (
        await loadDormantOpsModuleState(
          {
            module: "work_items",
            scope: { sort: "last_activity_at_desc" },
            page_size: 100,
            cursor: null,
          },
          pagedCapabilities,
        )
      ).status,
      "unavailable",
    );
  });
  assert.equal(view.result.current.mutationsDisabled, true);
  view.unmount();
  client.clear();
});

test("an older capability probe cannot re-enable real hook mutations", async () => {
  const pagedCapabilities = {
    ...capabilities,
    modules: [
      {
        name: "work_items",
        schema_version: 1,
        paged: true,
        collection_revision: 3,
      },
    ],
  };
  queue("ops_bridge_capabilities", pagedCapabilities, pagedCapabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });
  queue("ops_bridge_page", {
    contract_version: 1,
    revision: 3,
    generated_at: "2026-08-30T00:00:00Z",
    items: [{ extra: true }],
    next_cursor: null,
  });

  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  await act(async () => {
    assert.equal(
      (
        await loadDormantOpsModuleState(
          {
            module: "work_items",
            scope: { sort: "last_activity_at_desc" },
            page_size: 100,
            cursor: null,
          },
          pagedCapabilities,
        )
      ).status,
      "contract_invalid",
    );
  });
  assert.equal(view.result.current.mutationsDisabled, true);

  let resolveOlder;
  const olderAbsent = new Promise((resolve) => {
    resolveOlder = resolve;
  });
  queue("ops_bridge_capabilities", olderAbsent, {
    ...capabilities,
    modules: [{ name: "work_items", schema_version: 1, paged: false }],
  });
  await act(async () => {
    const pendingOlder = getOpsCapabilities();
    await getOpsCapabilities();
    resolveOlder({ ...capabilities, modules: [] });
    await pendingOlder;
  });

  assert.equal(view.result.current.mutationsDisabled, true);
  assert.equal(view.result.current.snapshot.revision, 2);
  assert.equal(view.result.current.state, "ready");
  view.unmount();
  client.clear();
});

function wrapper(client) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

async function mount(selection = {}) {
  const { renderHook } = await import("@testing-library/react");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const view = renderHook(() => useOpsSnapshot(selection), {
    wrapper: wrapper(client),
  });
  return { client, view };
}

async function mountSelectable(initialSelection = {}) {
  const { renderHook } = await import("@testing-library/react");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const view = renderHook((selection) => useOpsSnapshot(selection), {
    initialProps: initialSelection,
    wrapper: wrapper(client),
  });
  return { client, view };
}

async function waitForState(view, state) {
  const { act } = await import("@testing-library/react");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      if (fakeTimersEnabled) mock.timers.tick(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });
    if (view.result.current.state === state) return;
  }
  assert.equal(view.result.current.state, state);
}

async function waitForRevision(view, revision) {
  const { act } = await import("@testing-library/react");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      if (fakeTimersEnabled) mock.timers.tick(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });
    if (view.result.current.snapshot?.revision === revision) return;
  }
  assert.equal(view.result.current.snapshot?.revision, revision);
}

async function waitForCallCount(command, expected) {
  const { act } = await import("@testing-library/react");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      if (fakeTimersEnabled) mock.timers.tick(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });
    if (opsCalls(command).length === expected) return;
  }
  assert.equal(opsCalls(command).length, expected);
}

function enableFakeTimeouts() {
  mock.timers.enable({ apis: ["setTimeout"] });
  fakeTimersEnabled = true;
}

async function tick(milliseconds) {
  const { act } = await import("@testing-library/react");
  await act(async () => mock.timers.tick(milliseconds));
}

function opsCalls(command) {
  return calls.filter((call) => call.command === command);
}

test("first valid snapshot becomes ready, then starts one watcher and one invalidation listener", async () => {
  queue("ops_bridge_capabilities", capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({ channel: "all" });
  await waitForRevision(view, 2);

  assert.equal(view.result.current.snapshot.revision, 2);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(opsCalls("plugin:event|listen").length, 1);
  assert.deepEqual(opsCalls("ops_bridge_capabilities")[0].args, null);
  assert.deepEqual(opsCalls("ops_bridge_snapshot")[0].args, {
    selection: { channel: "all", thread: null, limit: 100 },
  });

  view.unmount();
  client.clear();
});

test("watch setup installs the listener before native start and immediately refetches the active snapshot", async () => {
  queue("ops_bridge_capabilities", capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForRevision(view, 2);

  assert.deepEqual(
    calls
      .filter((call) =>
        [
          "ops_bridge_capabilities",
          "ops_bridge_snapshot",
          "plugin:event|listen",
          "ops_bridge_start_watch",
        ].includes(call.command),
      )
      .map((call) => call.command),
    [
      "ops_bridge_capabilities",
      "ops_bridge_snapshot",
      "plugin:event|listen",
      "ops_bridge_start_watch",
      "ops_bridge_capabilities",
      "ops_bridge_snapshot",
    ],
  );
  view.unmount();
  client.clear();
});

test("a transient listener failure retries setup after snapshot recovery without starting native early", async () => {
  enableFakeTimeouts();
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), snapshot(3));
  queue("plugin:event|listen", new Error("listen unavailable"), 42);
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForState(view, "stale");
  assert.equal(opsCalls("ops_bridge_start_watch").length, 0);
  await tick(2_000);
  await waitForRevision(view, 3);

  assert.equal(opsCalls("plugin:event|listen").length, 2);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(view.result.current.state, "ready");
  view.unmount();
  client.clear();
});

test("a transient native start failure cleans the listener and retries after snapshot recovery", async () => {
  enableFakeTimeouts();
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), snapshot(3));
  queue("ops_bridge_start_watch", new Error("ops_bridge_disconnected"), {
    started: true,
  });

  const { client, view } = await mount({});
  await waitForState(view, "stale");
  assert.equal(opsCalls("plugin:event|unlisten").length, 1);
  await tick(2_000);
  await waitForRevision(view, 3);

  assert.equal(opsCalls("plugin:event|listen").length, 2);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 2);
  assert.equal(view.result.current.state, "ready");
  view.unmount();
  client.clear();
});

test("two hooks under StrictMode share one native start and one listener", async () => {
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    capabilities,
    capabilities,
  );
  queue(
    "ops_bridge_snapshot",
    snapshot(1),
    snapshot(1),
    snapshot(1),
    snapshot(1),
  );
  queue("ops_bridge_start_watch", { started: true });
  const { renderHook } = await import("@testing-library/react");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const view = renderHook(() => [useOpsSnapshot({}), useOpsSnapshot({})], {
    wrapper: ({ children }) =>
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(QueryClientProvider, { client }, children),
      ),
  });
  const firstHook = {
    result: {
      get current() {
        return view.result.current[0];
      },
    },
  };
  await waitForState(firstHook, "ready");
  await waitForCallCount("ops_bridge_start_watch", 1);
  await waitForCallCount("plugin:event|listen", 1);

  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(opsCalls("plugin:event|listen").length, 1);
  view.unmount();
  await Promise.resolve();
  assert.equal(opsCalls("plugin:event|unlisten").length, 1);
  client.clear();
});

test("community reset tears down the singleton and the next mount installs it afresh", async () => {
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    capabilities,
    capabilities,
  );
  queue(
    "ops_bridge_snapshot",
    snapshot(1),
    snapshot(2),
    snapshot(3),
    snapshot(4),
  );
  queue(
    "ops_bridge_start_watch",
    { started: true },
    {
      started: false,
      connection_generation: 9,
      sync_required: true,
      anchor_sequence: "3",
    },
  );
  queue("ops_bridge_ack_sync", {
    accepted: true,
    connection_generation: 9,
  });
  const { act } = await import("@testing-library/react");

  const first = await mount({ channel: "project:a" });
  await waitForRevision(first.view, 2);
  await act(async () => resetOpsWatchManager());
  assert.equal(opsCalls("plugin:event|unlisten").length, 1);
  first.view.unmount();
  first.client.clear();

  const second = await mount({ channel: "project:b" });
  await waitForRevision(second.view, 4);
  assert.equal(opsCalls("plugin:event|listen").length, 2);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 2);
  assert.deepEqual(opsCalls("ops_bridge_ack_sync"), [
    {
      command: "ops_bridge_ack_sync",
      args: { request: { generation: 9, applied_sequence: "4" } },
    },
  ]);
  second.view.unmount();
  second.client.clear();
});

test("an older snapshot stays readable with an explicit disabled compatibility watch state", async () => {
  queue("ops_bridge_capabilities", capabilities);
  queue("ops_bridge_snapshot", snapshot(1, { event_sequence: undefined }));

  const { client, view } = await mount({});
  await waitForState(view, "ready");

  assert.equal(view.result.current.snapshot.revision, 1);
  assert.equal(view.result.current.watchState, "disabled_compatibility");
  assert.equal(opsCalls("plugin:event|listen").length, 0);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 0);
  assert.equal(opsCalls("ops_bridge_ack_sync").length, 0);

  view.unmount();
  client.clear();
});

test("an invalidation event refetches the active snapshot and full_reload invalidates the Ops prefix", async () => {
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    capabilities,
    capabilities,
  );
  queue(
    "ops_bridge_snapshot",
    snapshot(1),
    snapshot(2),
    snapshot(3),
    snapshot(4),
  );
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  const eventCall = opsCalls("plugin:event|listen")[0];
  const handler = callbacks.get(eventCall.args.handler);

  await act(async () =>
    handler({ event: "buzz://ops-invalidated", id: 1, payload: {} }),
  );
  await waitForRevision(view, 3);
  assert.equal(view.result.current.snapshot.revision, 3);

  client.setQueryData(["ops", "other"], { revision: 1 });
  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 2,
      payload: { full_reload: true },
    }),
  );
  await waitForRevision(view, 4);
  assert.equal(view.result.current.snapshot.revision, 4);
  assert.equal(client.getQueryState(["ops", "other"]).isInvalidated, true);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(opsCalls("plugin:event|listen").length, 1);

  view.unmount();
  client.clear();
});

test("overlapping live invalidations drain through a follow-up canonical refetch", async () => {
  let resolveFirstInvalidation;
  const firstInvalidation = new Promise((resolve) => {
    resolveFirstInvalidation = resolve;
  });
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    capabilities,
    capabilities,
  );
  queue(
    "ops_bridge_snapshot",
    snapshot(1),
    snapshot(2),
    firstInvalidation,
    snapshot(4),
  );
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  const handler = callbacks.get(
    opsCalls("plugin:event|listen")[0].args.handler,
  );

  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 1,
      payload: { event_id: "3", event_type: "health" },
    }),
  );
  await waitForCallCount("ops_bridge_snapshot", 3);
  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 2,
      payload: { event_id: "4", event_type: "approval" },
    }),
  );
  await act(async () => resolveFirstInvalidation(snapshot(3)));
  await waitForRevision(view, 4);

  assert.equal(opsCalls("ops_bridge_snapshot").length, 4);
  view.unmount();
  client.clear();
});

test("sync-required refetch acknowledges the matching generation only after success", async () => {
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(10), snapshot(11), snapshot(12));
  queue("ops_bridge_start_watch", { started: true });
  queue("ops_bridge_ack_sync", {
    accepted: true,
    connection_generation: 100,
  });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 11);
  const handler = callbacks.get(
    opsCalls("plugin:event|listen")[0].args.handler,
  );

  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 1,
      payload: {
        connection_generation: 100,
        sync_required: true,
        anchor_sequence: "11",
        reason: "control",
        full_reload: true,
      },
    }),
  );
  await waitForRevision(view, 12);
  await waitForCallCount("ops_bridge_ack_sync", 1);

  assert.ok(
    calls.findIndex(
      (call) =>
        call.command === "ops_bridge_snapshot" &&
        opsCalls("ops_bridge_snapshot").indexOf(call) === 2,
    ) < calls.findIndex((call) => call.command === "ops_bridge_ack_sync"),
  );
  assert.deepEqual(opsCalls("ops_bridge_ack_sync"), [
    {
      command: "ops_bridge_ack_sync",
      args: {
        request: { generation: 100, applied_sequence: "12" },
      },
    },
  ]);
  view.unmount();
  client.clear();
});

test("a failed sync-required refetch stays suspended and sends no ACK", async () => {
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue(
    "ops_bridge_snapshot",
    snapshot(20),
    snapshot(21),
    new Error("ops_bridge_disconnected"),
  );
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 21);
  const handler = callbacks.get(
    opsCalls("plugin:event|listen")[0].args.handler,
  );

  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 1,
      payload: {
        connection_generation: 9,
        sync_required: true,
        anchor_sequence: "21",
        reason: "reconnect",
        full_reload: true,
      },
    }),
  );
  await waitForState(view, "stale");

  assert.equal(opsCalls("ops_bridge_ack_sync").length, 0);
  view.unmount();
  client.clear();
});

test("a successful stale recovery acknowledges the still-current failed sync refetch", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    capabilities,
    capabilities,
  );
  queue(
    "ops_bridge_snapshot",
    snapshot(20),
    snapshot(21),
    new Error("ops_bridge_disconnected"),
    snapshot(22),
  );
  queue("ops_bridge_start_watch", { started: true });
  queue("ops_bridge_ack_sync", {
    accepted: true,
    connection_generation: 9,
  });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 21);
  const handler = callbacks.get(
    opsCalls("plugin:event|listen")[0].args.handler,
  );

  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 1,
      payload: {
        connection_generation: 9,
        sync_required: true,
        anchor_sequence: "21",
        reason: "reconnect",
        full_reload: true,
      },
    }),
  );
  await waitForState(view, "stale");
  assert.equal(opsCalls("ops_bridge_ack_sync").length, 0);

  await tick(2_000);
  await waitForRevision(view, 22);
  await waitForCallCount("ops_bridge_ack_sync", 1);
  assert.deepEqual(opsCalls("ops_bridge_ack_sync"), [
    {
      command: "ops_bridge_ack_sync",
      args: {
        request: { generation: 9, applied_sequence: "22" },
      },
    },
  ]);

  view.unmount();
  client.clear();
});

test("community reset stops native sync and suppresses an old in-flight ACK", async () => {
  let resolveSyncRefetch;
  const syncRefetch = new Promise((resolve) => {
    resolveSyncRefetch = resolve;
  });
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(30), snapshot(31), syncRefetch);
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 31);
  const handler = callbacks.get(
    opsCalls("plugin:event|listen")[0].args.handler,
  );

  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 1,
      payload: {
        connection_generation: 12,
        sync_required: true,
        anchor_sequence: "31",
        reason: "reconnect",
        full_reload: true,
      },
    }),
  );
  await waitForCallCount("ops_bridge_snapshot", 3);
  await act(async () => resetOpsWatchManager());

  assert.deepEqual(opsCalls("ops_bridge_stop_watch"), [
    { command: "ops_bridge_stop_watch", args: null },
  ]);
  await act(async () => resolveSyncRefetch(snapshot(32)));
  await waitForRevision(view, 32);
  assert.equal(opsCalls("ops_bridge_ack_sync").length, 0);

  view.unmount();
  client.clear();
});

test("community reset waits for an in-flight native start before stopping", async () => {
  let resolveStart;
  const startResponse = new Promise((resolve) => {
    resolveStart = resolve;
  });
  queue("ops_bridge_capabilities", capabilities);
  queue("ops_bridge_snapshot", snapshot(40));
  queue("ops_bridge_start_watch", startResponse);
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForState(view, "ready");
  await waitForCallCount("ops_bridge_start_watch", 1);

  const resetting = resetOpsWatchManager();
  await Promise.resolve();
  assert.equal(opsCalls("ops_bridge_stop_watch").length, 0);
  await act(async () => {
    resolveStart({ started: true });
    await resetting;
  });

  const lifecycleCommands = calls
    .filter(({ command }) =>
      ["ops_bridge_start_watch", "ops_bridge_stop_watch"].includes(command),
    )
    .map(({ command }) => command);
  assert.deepEqual(lifecycleCommands, [
    "ops_bridge_start_watch",
    "ops_bridge_stop_watch",
  ]);
  view.unmount();
  client.clear();
});

test("browser reset skips the native stop command", async () => {
  const tauriInternals = window.__TAURI_INTERNALS__;
  const tauriRuntimeFlag = globalThis.isTauri;
  delete window.__TAURI_INTERNALS__;
  delete globalThis.isTauri;
  try {
    await assert.doesNotReject(resetOpsWatchManager());
    assert.equal(opsCalls("ops_bridge_stop_watch").length, 0);
  } finally {
    window.__TAURI_INTERNALS__ = tauriInternals;
    globalThis.isTauri = tauriRuntimeFlag;
  }
});

test("a deferred selection B fetch never exposes selection A as ready or stale", async () => {
  let rejectSelectionB;
  const selectionB = new Promise((_, reject) => {
    rejectSelectionB = reject;
  });
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), selectionB);
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mountSelectable({ channel: "project:a" });
  await waitForRevision(view, 2);

  await act(async () => view.rerender({ channel: "project:b" }));
  await waitForCallCount("ops_bridge_snapshot", 3);
  assert.equal(view.result.current.state, "loading");
  assert.equal(view.result.current.snapshot, null);

  await act(async () => rejectSelectionB(new Error("ops_bridge_disconnected")));
  await waitForState(view, "disconnected");
  assert.equal(view.result.current.snapshot, null);

  view.unmount();
  client.clear();
});

test("a terminal probe failure from selection A does not classify deferred selection B", async () => {
  enableFakeTimeouts();
  let rejectSelectionB;
  const selectionB = new Promise((_, reject) => {
    rejectSelectionB = reject;
  });
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    "ops_bridge_token_permissions",
    capabilities,
  );
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), selectionB);
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mountSelectable({ channel: "project:a" });
  await waitForRevision(view, 2);
  await tick(10_000);
  await waitForState(view, "not_configured");

  await act(async () => view.rerender({ channel: "project:b" }));
  await waitForCallCount("ops_bridge_snapshot", 3);
  assert.equal(view.result.current.state, "loading");
  assert.equal(view.result.current.snapshot, null);

  await act(async () => rejectSelectionB(new Error("ops_bridge_disconnected")));
  await waitForState(view, "disconnected");
  assert.equal(view.result.current.snapshot, null);

  view.unmount();
  client.clear();
});

test("native setup errors become not_configured without starting polling or watch", async () => {
  enableFakeTimeouts();
  queue("ops_bridge_capabilities", "ops_bridge_token_unavailable");

  const { client, view } = await mount({});
  await waitForState(view, "not_configured");
  await tick(30_000);

  assert.equal(opsCalls("ops_bridge_capabilities").length, 1);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 0);
  assert.equal(opsCalls("plugin:event|listen").length, 0);
  view.unmount();
  client.clear();
});

test("a disconnected first fetch retries capabilities and snapshot after exactly two seconds", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    new Error("ops_bridge_disconnected"),
    capabilities,
    capabilities,
  );
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForState(view, "disconnected");
  await tick(1_999);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 1);
  await tick(1);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);
  await waitForState(view, "ready");

  await waitForRevision(view, 2);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 3);
  assert.equal(opsCalls("ops_bridge_snapshot").length, 2);
  view.unmount();
  client.clear();
});

test("the ten-second health probe moves ready to stale and the two-second recovery keeps last-good data", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    new Error("ops_bridge_disconnected"),
    capabilities,
  );
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), snapshot(3));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  await tick(9_999);
  assert.equal(view.result.current.state, "ready");
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);

  await tick(1);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 3);
  await waitForState(view, "stale");
  assert.equal(view.result.current.snapshot.revision, 2);
  assert.equal(opsCalls("ops_bridge_snapshot").length, 2);

  await tick(1_999);
  assert.equal(view.result.current.state, "stale");
  await tick(1);
  await waitForState(view, "ready");
  assert.equal(view.result.current.snapshot.revision, 3);

  view.unmount();
  client.clear();
});

test("a terminal setup error during stale recovery stops the two-second poll", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    capabilities,
    capabilities,
    new Error("ops_bridge_disconnected"),
    "ops_bridge_token_permissions",
  );
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForRevision(view, 2);
  await tick(10_000);
  await waitForState(view, "stale");
  await tick(2_000);
  await waitForState(view, "not_configured");
  await tick(10_000);

  assert.equal(opsCalls("ops_bridge_capabilities").length, 4);
  assert.equal(view.result.current.snapshot.revision, 2);
  view.unmount();
  client.clear();
});

test("blur pauses timers, focus refetches once, and unmount removes the listener and timers", async () => {
  enableFakeTimeouts();
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), snapshot(3));
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForRevision(view, 2);

  focused = false;
  await act(async () => window.dispatchEvent(new window.Event("blur")));
  await tick(30_000);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);

  focused = true;
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  await waitForState(view, "ready");
  assert.equal(view.result.current.snapshot.revision, 3);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 3);

  view.unmount();
  await Promise.resolve();
  assert.equal(opsCalls("plugin:event|unlisten").length, 1);
  await tick(30_000);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 3);
  client.clear();
});
