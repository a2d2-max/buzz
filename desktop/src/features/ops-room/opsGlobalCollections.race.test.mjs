import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.assign(globalThis, {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const globalCollections = await import("./opsGlobalCollections.ts").catch(
  () => ({}),
);
const views = await import("./ui/OpsHomeWorkViews.tsx").catch(() => ({}));
const screenBoundary = await import("./ui/OpsRoomScreen.tsx").catch(() => ({}));

afterEach(cleanup);

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const capabilities = (revision) => ({
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
  modules: [
    {
      name: "work_items",
      schema_version: 1,
      paged: true,
      collection_revision: revision,
    },
  ],
});
const workItem = (id) => ({
  id,
  project_id: "project:raou",
  title: id,
  status: "active",
  progress: 0.5,
  last_activity_at: "2026-08-30T00:00:00Z",
  session_count: 0,
  approval_count: 0,
  artifact_count: 0,
});

test("stale restart promotes authoritative capabilities before old-key data is observable", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  let capabilityCalls = 0;
  let sharedRefresh;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => capabilities(++capabilityCalls),
      loadCollection: async (_request, refreshCapabilities) => {
        sharedRefresh = refreshCapabilities;
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      result.collections.workItems[0]?.id ?? "pending",
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => assert.equal(calls, 1));
  assert.equal(typeof sharedRefresh, "function");
  const refreshedCapabilities = await sharedRefresh();
  assert.equal(refreshedCapabilities.modules[0].collection_revision, 2);
  await act(async () => {
    first.resolve({
      status: "ready",
      items: [workItem("work:restart-result")],
      revision: 2,
      refreshed: true,
      authoritativeCapabilities: capabilities(2),
    });
    await first.promise;
  });
  await waitFor(() =>
    assert.equal(
      client.getQueryData(["ops", "global-capabilities"]).modules[0]
        .collection_revision,
      2,
    ),
  );
  await waitFor(() => assert.equal(calls, 2));
  assert.equal(view.queryByText("work:restart-result"), null);
  await act(async () => {
    second.resolve({
      status: "ready",
      items: [workItem("work:revision-2")],
      revision: 2,
      refreshed: false,
    });
    await second.promise;
  });
  await waitFor(() => assert.ok(view.getByText("work:revision-2")));
  cleanup();
});

test("late older stale restart cannot downgrade capabilities promoted by a newer module", async () => {
  const olderWork = deferred();
  const newerEvidence = deferred();
  const calls = { evidence: 0, work_items: 0 };
  const capabilitiesForModules = (revision) => ({
    ...capabilities(revision),
    modules: [
      capabilities(revision).modules[0],
      {
        name: "evidence",
        schema_version: 1,
        paged: true,
        collection_revision: revision,
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => capabilitiesForModules(1),
      loadCollection: async (request) => {
        calls[request.module] += 1;
        if (request.module === "work_items") {
          if (calls.work_items === 1) return olderWork.promise;
          return {
            status: "ready",
            items: [workItem("work:newest")],
            revision: 4,
            refreshed: false,
          };
        }
        if (calls.evidence === 1) return newerEvidence.promise;
        return {
          status: "ready",
          items: [],
          revision: 4,
          refreshed: false,
        };
      },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      result.collections.workItems[0]?.id ?? "pending",
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => {
    assert.equal(calls.work_items, 1);
    assert.equal(calls.evidence, 1);
  });
  act(() => {
    client.setQueryData(
      ["ops", "global-capabilities"],
      capabilitiesForModules(4),
    );
  });
  await act(async () => {
    newerEvidence.resolve({
      status: "ready",
      items: [],
      revision: 4,
      refreshed: true,
      authoritativeCapabilities: capabilitiesForModules(4),
    });
    await newerEvidence.promise;
  });
  await waitFor(() => assert.ok(view.getByText("work:newest")));
  assert.equal(
    client.getQueryData(["ops", "global-capabilities"]).modules[0]
      .collection_revision,
    4,
  );

  await act(async () => {
    olderWork.resolve({
      status: "ready",
      items: [workItem("work:older")],
      revision: 2,
      refreshed: true,
      authoritativeCapabilities: capabilitiesForModules(2),
    });
    await olderWork.promise;
  });
  assert.equal(
    client.getQueryData(["ops", "global-capabilities"]).modules[0]
      .collection_revision,
    4,
  );
  assert.ok(view.getByText("work:newest"));
  assert.equal(view.queryByText("work:older"), null);
});

test("two stale query paths share one capabilities refresh flight", async () => {
  const releaseStale = deferred();
  const capabilityRefresh = deferred();
  let capabilityCalls = 0;
  const calls = { evidence: 0, work_items: 0 };
  const received = [];
  const capabilitiesForModules = (revision) => ({
    ...capabilities(revision),
    modules: [
      capabilities(revision).modules[0],
      {
        name: "evidence",
        schema_version: 1,
        paged: true,
        collection_revision: revision,
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => {
        capabilityCalls += 1;
        return capabilityCalls === 1
          ? capabilitiesForModules(1)
          : capabilityRefresh.promise;
      },
      loadCollection: async (request, refreshCapabilities) => {
        calls[request.module] += 1;
        if (calls[request.module] === 1) {
          await releaseStale.promise;
          const next = await refreshCapabilities();
          received.push(next);
          return {
            status: "ready",
            items:
              request.module === "work_items"
                ? [workItem("work:stale-result")]
                : [],
            revision: 2,
            refreshed: true,
            authoritativeCapabilities: next,
          };
        }
        return {
          status: "ready",
          items:
            request.module === "work_items" ? [workItem("work:current")] : [],
          revision: 2,
          refreshed: false,
        };
      },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      result.collections.workItems[0]?.id ?? "pending",
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => {
    assert.equal(calls.work_items, 1);
    assert.equal(calls.evidence, 1);
  });
  releaseStale.resolve();
  await waitFor(() => assert.equal(capabilityCalls, 2));
  capabilityRefresh.resolve(capabilitiesForModules(2));
  await waitFor(() => assert.equal(received.length, 2));
  assert.ok(received[0] === received[1]);
  assert.equal(capabilityCalls, 2);
  await waitFor(() => assert.ok(view.getByText("work:current")));
  assert.equal(
    client.getQueryData(["ops", "global-capabilities"]).modules[0]
      .collection_revision,
    2,
  );
});

test("late old-key result cannot replace current global collection", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => capabilities(1),
      loadCollection: async () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      result.collections.workItems[0]?.id ?? "pending",
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => assert.equal(calls, 1));
  act(() => {
    client.setQueryData(["ops", "global-capabilities"], capabilities(2));
  });
  await waitFor(() => assert.equal(calls, 2));
  await act(async () => {
    second.resolve({
      status: "ready",
      items: [workItem("work:current")],
      revision: 2,
      refreshed: false,
    });
    await second.promise;
  });
  await waitFor(() => assert.ok(view.getByText("work:current")));
  await act(async () => {
    first.resolve({
      status: "ready",
      items: [workItem("work:late")],
      revision: 1,
      refreshed: false,
    });
    await first.promise;
  });
  assert.ok(view.getByText("work:current"));
  assert.equal(view.queryByText("work:late"), null);
  cleanup();
});

test("advertised deferred modules remain explicitly pending after a sibling is ready", async () => {
  const evidence = deferred();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => ({
        ...capabilities(1),
        modules: [
          capabilities(1).modules[0],
          {
            name: "evidence",
            schema_version: 1,
            paged: true,
            collection_revision: 1,
          },
        ],
      }),
      loadCollection: async (request) =>
        request.module === "work_items"
          ? {
              status: "ready",
              items: [workItem("work:ready")],
              revision: 1,
              refreshed: false,
            }
          : evidence.promise,
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      `${result.states.work_items?.status ?? "missing"}:${result.states.evidence?.status ?? "missing"}`,
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => assert.ok(view.getByText("ready:pending")));
  cleanup();
});

test("direct Work keeps sibling-ready content out of a pending work lifecycle", async () => {
  const work = deferred();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => ({
        ...capabilities(1),
        modules: [
          capabilities(1).modules[0],
          {
            name: "evidence",
            schema_version: 1,
            paged: true,
            collection_revision: 1,
          },
        ],
      }),
      loadCollection: async (request) =>
        request.module === "work_items"
          ? work.promise
          : {
              status: "ready",
              items: [],
              revision: 1,
              refreshed: false,
            },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      `${screenBoundary.opsWorkRouteMode(
        null,
        result.collections.workItems,
        result.states.work_items,
      )}:${result.states.evidence?.status}`,
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => assert.ok(view.getByText("pending:ready")));
  await act(async () => {
    work.resolve({
      status: "ready",
      items: [workItem("work:a")],
      revision: 1,
      refreshed: false,
    });
    await work.promise;
  });
  await waitFor(() => assert.ok(view.getByText("updating:ready")));
});

test("selection switch exposes checklist pending and never reuses the old selection", async () => {
  const secondChecklist = deferred();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe({ selectedWorkId }) {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => ({
        ...capabilities(1),
        modules: [
          capabilities(1).modules[0],
          {
            name: "checklist_items",
            schema_version: 1,
            paged: true,
            collection_revision: 1,
          },
        ],
      }),
      loadCollection: async (request) => {
        if (request.module === "work_items") {
          return {
            status: "ready",
            items: [workItem("work:a"), workItem("work:b")],
            revision: 1,
            refreshed: false,
          };
        }
        if (request.scope.work_item === "work:b") {
          return secondChecklist.promise;
        }
        return {
          status: "ready",
          items: [{ id: "check:a", work_item_id: "work:a" }],
          revision: 1,
          refreshed: false,
        };
      },
      searchRequest: null,
      selectedWorkId,
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(
      "output",
      null,
      result.states.checklist_items?.status === "ready"
        ? result.collections.checklist[0]?.id
        : (result.states.checklist_items?.status ?? "missing"),
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, { selectedWorkId: "work:a" }),
    ),
  );
  await waitFor(() => assert.ok(view.getByText("check:a")));
  view.rerender(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, { selectedWorkId: "work:b" }),
    ),
  );
  await waitFor(() => assert.ok(view.getByText("pending")));
  assert.equal(view.queryByText("check:a"), null);
  await act(async () => {
    secondChecklist.resolve({
      status: "ready",
      items: [{ id: "check:b", work_item_id: "work:b" }],
      revision: 1,
      refreshed: false,
    });
    await secondChecklist.promise;
  });
  await waitFor(() => assert.ok(view.getByText("check:b")));
  cleanup();
});

test("existing Work selection shows deferred revision lifecycle before replacement data", async () => {
  const revisionTwo = deferred();
  let workCalls = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => capabilities(1),
      loadCollection: async () => {
        workCalls += 1;
        if (workCalls === 1) {
          return {
            status: "ready",
            items: [workItem("work:a")],
            revision: 1,
            refreshed: false,
          };
        }
        return revisionTwo.promise;
      },
      searchRequest: null,
      selectedWorkId: "work:a",
      subscribeInvalidations: () => () => {},
    });
    return React.createElement(views.OpsWorkView, {
      collections: result.collections,
      layout: "desktop",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
      states: result.states,
    });
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() => assert.ok(view.getByRole("heading", { name: "work:a" })));
  act(() => {
    client.setQueryData(["ops", "global-capabilities"], capabilities(2));
  });
  await waitFor(() => assert.ok(view.getByText("Work is loading.")));
  assert.equal(view.queryByText("No work is active."), null);
  await act(async () => {
    revisionTwo.resolve({
      status: "ready",
      items: [{ ...workItem("work:a"), title: "Revision two" }],
      revision: 2,
      refreshed: false,
    });
    await revisionTwo.promise;
  });
  await waitFor(() =>
    assert.ok(view.getByRole("heading", { name: "Revision two" })),
  );
});

test("late selected-work/capability result cannot replace the current query", async () => {
  assert.equal(
    typeof globalCollections.useOpsCompleteCollectionQuery,
    "function",
  );
  const first = deferred();
  const second = deferred();
  const calls = [];
  const load = (request) => {
    calls.push(request);
    return calls.length === 1 ? first.promise : second.promise;
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const checklist = {
    module: "checklist_items",
    scope: { work_item: "work:a", sort: "order_asc_then_id" },
  };
  const search = {
    module: "search",
    scope: {
      q: "  exact  ",
      kind: "evidence",
      work: "work:b",
      sort: "rank_desc_then_observed_at_desc",
    },
  };

  function Probe({ capabilityRevision, invalidationRevision, request }) {
    const query = globalCollections.useOpsCompleteCollectionQuery({
      capabilityRevision,
      invalidationRevision,
      load,
      request,
    });
    return React.createElement(
      "output",
      null,
      query.data?.status === "ready" ? query.data.items[0]?.id : "pending",
    );
  }

  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, {
        capabilityRevision: 1,
        invalidationRevision: 10,
        request: checklist,
      }),
    ),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  view.rerender(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe, {
        capabilityRevision: 2,
        invalidationRevision: 11,
        request: search,
      }),
    ),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  await act(async () => {
    second.resolve({
      status: "ready",
      items: [{ id: "search:current" }],
      revision: 2,
      refreshed: false,
    });
    await second.promise;
  });
  await waitFor(() =>
    assert.equal(
      view.getByText("search:current").textContent,
      "search:current",
    ),
  );
  await act(async () => {
    first.resolve({
      status: "ready",
      items: [{ id: "check:late" }],
      revision: 1,
      refreshed: false,
    });
    await first.promise;
  });
  assert.equal(view.getByText("search:current").textContent, "search:current");
  assert.deepEqual(calls, [checklist, search]);
  cleanup();
});

test("eight advertised queries share one capability probe and ordinary invalidation refetches", async () => {
  let capabilityCalls = 0;
  let invalidated;
  const modules = [
    "work_items",
    "sessions",
    "checklist_items",
    "decisions",
    "approval_index",
    "evidence",
    "audit",
    "search",
  ];
  const loadCalls = [];
  const getCapabilities = async () => {
    capabilityCalls += 1;
    return {
      contract_version: 1,
      reads: ["snapshot", "events", "artifact"],
      drafts: [],
      transitions: [],
      modules: modules.map((name) => ({
        name,
        schema_version: 1,
        paged: true,
        collection_revision: capabilityCalls,
      })),
    };
  };
  const loadCollection = async (request) => {
    loadCalls.push(request.module);
    return {
      status: "ready",
      items: [],
      revision: capabilityCalls,
      refreshed: false,
    };
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities,
      loadCollection,
      searchRequest: {
        module: "search",
        scope: { q: "exact", sort: "rank_desc_then_observed_at_desc" },
      },
      selectedWorkId: "work:a",
      subscribeInvalidations: (listener) => {
        invalidated = listener;
        return () => {};
      },
    });
    return React.createElement(
      "output",
      null,
      result.pending ? "pending" : "ready",
    );
  }

  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() =>
    assert.equal(view.getByText("ready").textContent, "ready"),
  );
  assert.equal(capabilityCalls, 1);
  assert.deepEqual([...loadCalls].sort(), [...modules].sort());
  await act(async () => invalidated({ reason: "module_revision_changed" }));
  await waitFor(() => assert.equal(capabilityCalls, 2));
  await waitFor(() => assert.equal(loadCalls.length, 16));
  cleanup();
});

test("bounded global retry recovers a capability query failure", async () => {
  let attempts = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    const result = globalCollections.useOpsGlobalCollections({
      active: true,
      getCapabilities: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporarily unavailable");
        return {
          contract_version: 1,
          reads: ["snapshot", "events", "artifact"],
          drafts: [],
          transitions: [],
          modules: [],
        };
      },
      searchRequest: null,
      selectedWorkId: null,
      subscribeInvalidations: () => () => {},
    });
    assert.equal(typeof result.refetch, "function");
    return React.createElement(
      React.Fragment,
      null,
      React.createElement("output", null, result.error ? "error" : "ready"),
      React.createElement(
        "button",
        { onClick: () => void result.refetch(), type: "button" },
        "retry",
      ),
    );
  }
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe),
    ),
  );
  await waitFor(() =>
    assert.equal(view.getByText("error").textContent, "error"),
  );
  fireEvent.click(view.getByRole("button", { name: "retry" }));
  await waitFor(() =>
    assert.equal(view.getByText("ready").textContent, "ready"),
  );
  assert.equal(attempts, 2);
  cleanup();
});
