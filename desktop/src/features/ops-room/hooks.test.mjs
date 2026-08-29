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

function snapshot(revision = 1) {
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
    window: dom.window,
  });
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "plugin:event|listen") return 41;
      if (command === "plugin:event|unlisten") return null;
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
  mock.timers.reset();
});

after(() => dom.window.close());

const { useOpsSnapshot } = await import("./hooks.ts");

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

async function waitForState(view, state) {
  const { act } = await import("@testing-library/react");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => {
      if (fakeTimersEnabled) mock.timers.tick(0);
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
      await Promise.resolve();
      await Promise.resolve();
    });
    if (view.result.current.snapshot?.revision === revision) return;
  }
  assert.equal(view.result.current.snapshot?.revision, revision);
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
  queue("ops_bridge_capabilities", capabilities);
  queue("ops_bridge_snapshot", snapshot(1));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({ channel: "all" });
  await waitForState(view, "ready");

  assert.equal(view.result.current.snapshot.revision, 1);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(opsCalls("plugin:event|listen").length, 1);
  assert.deepEqual(opsCalls("ops_bridge_capabilities")[0].args, null);
  assert.deepEqual(opsCalls("ops_bridge_snapshot")[0].args, {
    selection: { channel: "all", thread: null, limit: 100 },
  });

  view.unmount();
  client.clear();
});

test("an invalidation event refetches the active snapshot and full_reload invalidates the Ops prefix", async () => {
  queue("ops_bridge_capabilities", capabilities, capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2), snapshot(3));
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForState(view, "ready");
  const eventCall = opsCalls("plugin:event|listen")[0];
  const handler = callbacks.get(eventCall.args.handler);

  await act(async () =>
    handler({ event: "buzz://ops-invalidated", id: 1, payload: {} }),
  );
  await waitForRevision(view, 2);
  assert.equal(view.result.current.snapshot.revision, 2);

  client.setQueryData(["ops", "other"], { revision: 1 });
  await act(async () =>
    handler({
      event: "buzz://ops-invalidated",
      id: 2,
      payload: { full_reload: true },
    }),
  );
  await waitForRevision(view, 3);
  assert.equal(view.result.current.snapshot.revision, 3);
  assert.equal(client.getQueryState(["ops", "other"]).isInvalidated, true);
  assert.equal(opsCalls("ops_bridge_start_watch").length, 1);
  assert.equal(opsCalls("plugin:event|listen").length, 1);

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
  );
  queue("ops_bridge_snapshot", snapshot(1));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForState(view, "disconnected");
  await tick(1_999);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 1);
  await tick(1);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);
  await waitForState(view, "ready");

  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);
  assert.equal(opsCalls("ops_bridge_snapshot").length, 1);
  view.unmount();
  client.clear();
});

test("the ten-second health probe moves ready to stale and the two-second recovery keeps last-good data", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    capabilities,
    new Error("ops_bridge_disconnected"),
    capabilities,
  );
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForState(view, "ready");
  await tick(9_999);
  assert.equal(view.result.current.state, "ready");
  assert.equal(opsCalls("ops_bridge_capabilities").length, 1);

  await tick(1);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);
  await waitForState(view, "stale");
  assert.equal(view.result.current.snapshot.revision, 1);
  assert.equal(opsCalls("ops_bridge_snapshot").length, 1);

  await tick(1_999);
  assert.equal(view.result.current.state, "stale");
  await tick(1);
  await waitForState(view, "ready");
  assert.equal(view.result.current.snapshot.revision, 2);

  view.unmount();
  client.clear();
});

test("a terminal setup error during stale recovery stops the two-second poll", async () => {
  enableFakeTimeouts();
  queue(
    "ops_bridge_capabilities",
    capabilities,
    new Error("ops_bridge_disconnected"),
    "ops_bridge_token_permissions",
  );
  queue("ops_bridge_snapshot", snapshot(1));
  queue("ops_bridge_start_watch", { started: true });

  const { client, view } = await mount({});
  await waitForState(view, "ready");
  await tick(10_000);
  await waitForState(view, "stale");
  await tick(2_000);
  await waitForState(view, "not_configured");
  await tick(10_000);

  assert.equal(opsCalls("ops_bridge_capabilities").length, 3);
  assert.equal(view.result.current.snapshot.revision, 1);
  view.unmount();
  client.clear();
});

test("blur pauses timers, focus refetches once, and unmount removes the listener and timers", async () => {
  enableFakeTimeouts();
  queue("ops_bridge_capabilities", capabilities, capabilities);
  queue("ops_bridge_snapshot", snapshot(1), snapshot(2));
  queue("ops_bridge_start_watch", { started: true });
  const { act } = await import("@testing-library/react");
  const { client, view } = await mount({});
  await waitForState(view, "ready");

  focused = false;
  await act(async () => window.dispatchEvent(new window.Event("blur")));
  await tick(30_000);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 1);

  focused = true;
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  await waitForState(view, "ready");
  assert.equal(view.result.current.snapshot.revision, 2);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);

  view.unmount();
  await Promise.resolve();
  assert.equal(opsCalls("plugin:event|unlisten").length, 1);
  await tick(30_000);
  assert.equal(opsCalls("ops_bridge_capabilities").length, 2);
  client.clear();
});
