import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom.window,
});

const { act, cleanup, renderHook, waitFor } = await import(
  "@testing-library/react"
);
const { useOpsOverviewCollections } = await import(
  "./opsOverviewCollections.ts"
);

afterEach(cleanup);
after(() => dom.window.close());

function capabilities(revision, modules = ["research"]) {
  return {
    contract_version: 1,
    reads: ["snapshot", "events", "artifact"],
    drafts: [],
    transitions: [],
    modules: modules.map((name) => ({
      name,
      schema_version: 1,
      paged: true,
      collection_revision: revision,
    })),
  };
}

function wrapper(client) {
  return ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

test("overview hook does not invoke absent modules and late old revision data cannot replace current rows", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let resolveOld;
  const old = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const calls = [];
  const loadCollection = async (request, captured) => {
    const revision = captured.modules[0].collection_revision;
    calls.push({ module: request.module, revision });
    if (revision === 3) return old;
    return {
      status: "ready",
      revision,
      refreshed: false,
      items: [
        {
          id: "research:new",
          title: "Current research",
          status: "complete",
        },
      ],
    };
  };
  const view = renderHook(
    ({ captured }) =>
      useOpsOverviewCollections({
        activeModules: ["research"],
        capabilities: captured,
        loadCollection,
      }),
    { initialProps: { captured: capabilities(3) }, wrapper: wrapper(client) },
  );
  await waitFor(() => assert.equal(calls.length, 1));
  view.rerender({ captured: capabilities(4) });
  await waitFor(() =>
    assert.equal(view.result.current.research.items[0]?.id, "research:new"),
  );
  await act(async () => {
    resolveOld({
      status: "ready",
      revision: 3,
      refreshed: false,
      items: [
        {
          id: "research:old",
          title: "Old research",
          status: "complete",
        },
      ],
    });
    await old;
  });
  assert.equal(view.result.current.research.items[0]?.id, "research:new");

  view.rerender({ captured: capabilities(4, []) });
  await waitFor(() =>
    assert.deepEqual(view.result.current.research, { status: "unavailable" }),
  );
  assert.equal(view.result.current.pending, false);
  assert.equal(calls.length, 2);
  client.clear();
});

test("overview retry refetches a failed active source query", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let attempts = 0;
  const view = renderHook(
    () =>
      useOpsOverviewCollections({
        activeModules: ["research"],
        capabilities: capabilities(8),
        async loadCollection() {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary overview failure");
          return {
            status: "ready",
            revision: 8,
            refreshed: false,
            items: [
              {
                id: "research:recovered",
                title: "Recovered research",
                status: "complete",
              },
            ],
          };
        },
      }),
    { wrapper: wrapper(client) },
  );
  await waitFor(() => assert.ok(view.result.current.error));
  assert.deepEqual(view.result.current.research, { status: "disconnected" });
  await act(async () => {
    await view.result.current.refetch();
  });
  await waitFor(() =>
    assert.equal(
      view.result.current.research.items[0]?.id,
      "research:recovered",
    ),
  );
  assert.equal(attempts, 2);
  client.clear();
});
