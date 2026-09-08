import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import { installBoardTestDom } from "../ui/communityTaskTestDom.mjs";

let dom;

before(() => {
  dom = installBoardTestDom();
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve([]),
    transformCallback: () => 1,
  };
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  mock.reset();
});

after(() => dom.window.close());

const TEST_QUERY_DEFAULTS = {
  mutations: { gcTime: 0, retry: false },
  queries: {
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  },
};

/** Stubs the relay: history is counted, the live REQ's readiness is ours to trigger. */
async function installRelay({ subscribe } = {}) {
  const { relayClient } = await import("@/shared/api/relayClient");
  const state = { fetches: 0, onReady: null, reconnect: null };
  mock.method(relayClient, "fetchEvents", () => {
    state.fetches += 1;
    return Promise.resolve([]);
  });
  mock.method(
    relayClient,
    "subscribeLive",
    subscribe ??
      ((_filter, _onEvent, onReady) => {
        state.onReady = onReady;
        return Promise.resolve(() => Promise.resolve());
      }),
  );
  mock.method(relayClient, "subscribeToReconnects", (listener) => {
    state.reconnect = listener;
    return () => {};
  });
  return state;
}

async function renderHook() {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities.tsx"
  );
  const { useCommunityTasks } = await import("./useCommunityTasks.ts");
  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  const latest = { current: null };
  function Probe() {
    latest.current = useCommunityTasks().query;
    return null;
  }
  const result = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunitiesProvider, null, createElement(Probe)),
    ),
  );
  return { ...result, latest, queryClient };
}

async function settle() {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("history waits for the live subscription to arm, then runs exactly once", async (t) => {
  const relay = await installRelay();
  const { latest, queryClient } = await renderHook();
  t.after(() => queryClient.clear());
  await settle();

  assert.equal(relay.fetches, 0, "no history before the live REQ is armed");
  assert.equal(latest.current.isPending, true, "still loading meanwhile");
  assert.ok(relay.onReady, "the live subscription was opened");

  const { act } = await import("@testing-library/react");
  await act(async () => {
    relay.onReady("eose");
  });
  await settle();
  await settle();

  assert.equal(relay.fetches, 1, "one walk, not a fetch plus an invalidate");
  assert.equal(latest.current.isPending, false);
  assert.deepEqual(latest.current.data, []);
});

test("a live subscription that fails still lets history load", async (t) => {
  const relay = await installRelay({
    subscribe: () => Promise.reject(new Error("relay unreachable")),
  });
  const priorError = console.error;
  console.error = () => {};
  const { latest, queryClient } = await renderHook();
  t.after(() => {
    queryClient.clear();
    console.error = priorError;
  });
  await settle();
  await settle();

  assert.equal(relay.fetches, 1);
  assert.equal(latest.current.isPending, false);
});

test("a reconnect refetches history", async (t) => {
  const relay = await installRelay();
  const { queryClient } = await renderHook();
  t.after(() => queryClient.clear());
  const { act } = await import("@testing-library/react");
  await act(async () => {
    relay.onReady("eose");
  });
  await settle();
  assert.equal(relay.fetches, 1);

  await act(async () => {
    relay.reconnect();
  });
  await settle();
  await settle();
  assert.equal(relay.fetches, 2);
});
