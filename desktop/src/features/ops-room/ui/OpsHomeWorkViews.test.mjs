import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.assign(globalThis, {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
});

const { cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const views = await import("./OpsHomeWorkViews.tsx").catch(() => ({}));

const workItems = [
  {
    id: "work:a",
    project_id: "project:raou",
    title: "Ship Home and Work",
    status: "active",
    progress: 0.6,
    last_activity_at: "2026-08-30T10:00:00Z",
    session_count: 1,
    approval_count: 1,
    artifact_count: 2,
  },
  {
    id: "work:b",
    project_id: "project:raou",
    title: "Review evidence",
    status: "blocked",
    progress: 0.2,
    last_activity_at: "2026-08-30T09:00:00Z",
    session_count: 0,
    approval_count: 0,
    artifact_count: 0,
  },
];
const collections = {
  workItems,
  sessions: [
    {
      id: "codex_direct:session-a",
      source: "codex_direct",
      parent_session_id: null,
      work_item_id: "work:a",
      title: "Landing worker",
      activity: "working",
      health: "live",
      last_activity_at: "2026-08-30T10:02:00Z",
      child_count: 0,
    },
  ],
  checklist: [
    {
      id: "check:one",
      work_item_id: "work:a",
      key: "1",
      title: "First canonical step",
      order: 1,
      origin: "instruction",
      status: "done",
      evidence_ids: ["evidence:a"],
      claimed_by_session_id: null,
      claimed_at: null,
      stage: "plan",
      next_action: "Run full gate",
      depends_on: ["check:zero"],
      updated_at: "2026-08-30T09:00:00Z",
      revision: 1,
    },
  ],
  decisions: [
    {
      id: "decision:a",
      work_item_id: "work:a",
      source: "checklist",
      source_id: "check:one",
      title: "Choose validation depth",
      question: "Which gate runs now?",
      options: ["Focused", "Full"],
      needed_input: "Select one",
      impact: "Changes completion time",
      queue: "user_decision",
      status: "open",
      updated_at: "2026-08-30T10:03:00Z",
      revision: 1,
    },
  ],
  approvals: [
    {
      id: "approval:a",
      work_item_id: "work:a",
      action_kind: "provider_run",
      status: "pending_approval",
      hold_reason: "Needs review",
      risk_class: ["dispatch_create"],
      updated_at: "2026-08-30T10:04:00Z",
      revision: 1,
    },
  ],
  evidence: [
    {
      id: "evidence:a",
      work_item_id: "work:a",
      kind: "test_report",
      status: "verified",
      observed_at: "2026-08-30T10:05:00Z",
      artifact_id: "artifact:a",
      artifact_version: 1,
    },
  ],
  audit: [
    {
      id: "audit:a",
      work_item_id: "work:a",
      kind: "work.updated",
      summary: "Checklist order confirmed",
      observed_at: "2026-08-30T10:06:00Z",
    },
  ],
  search: [
    {
      id: "search:a",
      kind: "evidence",
      title: "Test report",
      snippet: "All focused tests passed",
      observed_at: "2026-08-30T10:05:00Z",
      work_item_id: "work:a",
    },
  ],
};

afterEach(cleanup);

test("Home renders a connected operational pulse and opens selected work", () => {
  assert.equal(typeof views.OpsHomeView, "function");
  const opened = [];
  const view = render(
    React.createElement(views.OpsHomeView, {
      collections,
      onOpenWork: (id) => opened.push(id),
      refreshed: true,
    }),
  );
  assert.ok(view.getByRole("heading", { name: "Operational pulse" }));
  assert.ok(view.getByText("Today's work"));
  assert.ok(view.getByText("Landing worker"));
  assert.ok(view.getAllByText("Choose validation depth").length >= 2);
  assert.ok(view.getByText("Needs review"));
  assert.ok(view.getByText("Checklist order confirmed"));
  assert.ok(view.getByRole("heading", { name: "Recent decisions" }));
  assert.ok(view.getByText("Collection refreshed"));
  assert.equal(view.queryByText(/checklist total/i), null);
  fireEvent.click(view.getByRole("button", { name: /Ship Home and Work/ }));
  assert.deepEqual(opened, ["work:a"]);
});

test("Work renders master/detail and canonical Plan content without mutations", () => {
  assert.equal(typeof views.OpsWorkView, "function");
  const selected = [];
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "desktop",
      onSearch() {},
      onSelectWork: (id) => selected.push(id),
      selectedWorkId: "work:a",
    }),
  );
  assert.ok(view.getByRole("heading", { name: "Ship Home and Work" }));
  assert.ok(view.getByText("Landing worker"));
  assert.ok(view.getByText(/codex_direct · working · live/));
  assert.ok(view.getByText("2026-08-30T10:02:00Z"));
  assert.ok(view.getByText(/1 · First canonical step/));
  assert.ok(view.getByText(/plan · done/));
  assert.ok(view.getByText("Next: Run full gate"));
  assert.ok(view.getByText("Depends on: check:zero"));
  assert.ok(view.getByText("Evidence: evidence:a"));
  fireEvent.click(view.getByRole("tab", { name: "Attention" }));
  assert.ok(view.getByText("Focused · Full"));
  assert.ok(view.getByText("Select one"));
  assert.ok(view.getByText("Changes completion time"));
  assert.ok(view.getByText(/user_decision · open/));
  assert.ok(view.getByText(/provider_run · pending_approval/));
  assert.ok(view.getByText("Risk: dispatch_create"));
  fireEvent.click(view.getByRole("tab", { name: "Evidence" }));
  assert.ok(view.getByText(/test_report · verified/));
  assert.ok(view.getByText("artifact:a v1"));
  assert.ok(view.getAllByText("2026-08-30T10:05:00Z").length >= 1);
  assert.ok(view.getByText(/work.updated · 2026-08-30T10:06:00Z/));
  assert.equal(
    view.queryByRole("button", { name: /approve|deliver|run/i }),
    null,
  );
  fireEvent.click(view.getByRole("button", { name: /Review evidence/ }));
  assert.deepEqual(selected, ["work:b"]);
});

test("Work distinguishes true empty detail sections", () => {
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections: {
        ...collections,
        sessions: [],
        checklist: [],
        decisions: [],
        approvals: [],
        evidence: [],
        audit: [],
        search: [],
      },
      layout: "desktop",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  assert.ok(view.getByText("No sessions for this work."));
  assert.ok(view.getByText("No plan items for this work."));
  fireEvent.click(view.getByRole("tab", { name: "Attention" }));
  assert.ok(view.getByText("No decisions for this work."));
  assert.ok(view.getByText("No approvals for this work."));
  fireEvent.click(view.getByRole("tab", { name: "Evidence" }));
  assert.ok(view.getByText("No evidence for this work."));
  assert.ok(view.getByText("No audit entries for this work."));
});

test("Work missing selection reports work lifecycle before true ready-empty", () => {
  for (const [state, expected] of [
    [{ status: "pending" }, "Work is loading."],
    [{ status: "unavailable" }, "Work is unavailable."],
    [{ status: "contract_invalid" }, "Work contract is invalid."],
  ]) {
    const view = render(
      React.createElement(views.OpsWorkView, {
        collections: { ...collections, workItems: [] },
        layout: "desktop",
        onSearch() {},
        onSelectWork() {},
        selectedWorkId: "work:a",
        states: { work_items: state },
      }),
    );
    assert.ok(view.getByText(expected));
    assert.equal(view.queryByText("No work is active."), null);
    view.unmount();
  }

  const empty = render(
    React.createElement(views.OpsWorkView, {
      collections: { ...collections, workItems: [] },
      layout: "desktop",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
      states: {
        work_items: {
          status: "ready",
          items: [],
          revision: 2,
          refreshed: false,
        },
      },
    }),
  );
  assert.ok(empty.getByText("No work is active."));
});

test("Work renders selected checklist pending without a fabricated empty plan", () => {
  let view;
  assert.doesNotThrow(() => {
    view = render(
      React.createElement(views.OpsWorkView, {
        collections: { ...collections, checklist: [] },
        layout: "desktop",
        onSearch() {},
        onSelectWork() {},
        selectedWorkId: "work:b",
        states: { checklist_items: { status: "pending" } },
      }),
    );
  });
  assert.ok(view.getByText("Plan is loading."));
  assert.equal(view.queryByText("No plan items for this work."), null);
});

test("Work distinguishes pending and ready-empty search results", () => {
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections: { ...collections, search: [] },
      layout: "desktop",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
      states: { search: { status: "pending" } },
    }),
  );
  fireEvent.click(view.getByRole("tab", { name: "Evidence" }));
  assert.ok(view.getByText("Search is loading."));
  assert.equal(view.queryByText("No search results."), null);

  view.rerender(
    React.createElement(views.OpsWorkView, {
      collections: { ...collections, search: [] },
      layout: "desktop",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
      states: {
        search: {
          status: "ready",
          items: [],
          revision: 1,
          refreshed: false,
        },
      },
    }),
  );
  assert.ok(view.getByText("No search results."));
});

test("partial module failures stay distinct while ready work remains mounted", () => {
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "desktop",
      mutationsDisabled: true,
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
      states: {
        work_items: {
          status: "ready",
          items: workItems,
          revision: 1,
          refreshed: false,
        },
        evidence: { status: "unavailable" },
        audit: { status: "contract_invalid" },
      },
    }),
  );
  assert.ok(view.getByRole("heading", { name: "Ship Home and Work" }));
  assert.ok(view.getByText("Read-only: collection mutations are disabled."));
  fireEvent.click(view.getByRole("tab", { name: "Evidence" }));
  assert.ok(view.getByText("Evidence is unavailable."));
  assert.ok(view.getByText("Audit contract is invalid."));
  assert.equal(view.queryByText("No evidence for this work."), null);
});

test("Home gives ready-empty recent evidence and audit explicit copy", () => {
  const view = render(
    React.createElement(views.OpsHomeView, {
      collections: { ...collections, evidence: [], audit: [] },
      onOpenWork() {},
      states: {
        evidence: { status: "ready", items: [], revision: 1, refreshed: false },
        audit: { status: "ready", items: [], revision: 1, refreshed: false },
      },
    }),
  );
  assert.ok(view.getByText("No recent evidence."));
  assert.ok(view.getByText("No recent audit entries."));
});

test("Work search submits the exact string with closed kind and work scope", () => {
  assert.equal(typeof views.OpsWorkView, "function");
  const searches = [];
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "desktop",
      onSearch: (scope) => searches.push(scope),
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  fireEvent.change(view.getByRole("searchbox", { name: "Search work" }), {
    target: { value: "  exact Query  " },
  });
  fireEvent.change(view.getByLabelText("Search kind"), {
    target: { value: "evidence" },
  });
  fireEvent.click(view.getByRole("button", { name: "Search" }));
  assert.deepEqual(searches, [
    {
      q: "  exact Query  ",
      kind: "evidence",
      work: "work:a",
      sort: "rank_desc_then_observed_at_desc",
    },
  ]);
});

test("accepted search moves from Plan to the focused Evidence lifecycle and results", async () => {
  const props = {
    collections: { ...collections, search: [] },
    layout: "desktop",
    onSearch: () => true,
    onSelectWork() {},
    selectedWorkId: "work:a",
  };
  const view = render(
    React.createElement(views.OpsWorkView, {
      ...props,
      states: { search: { status: "not_requested" } },
    }),
  );
  fireEvent.change(view.getByRole("searchbox", { name: "Search work" }), {
    target: { value: "exact" },
  });
  fireEvent.click(view.getByRole("button", { name: "Search" }));
  const evidenceTab = view.getByRole("tab", { name: "Evidence" });
  assert.equal(evidenceTab.getAttribute("aria-selected"), "true");
  await waitFor(() =>
    assert.ok(document.activeElement === view.getByRole("tabpanel")),
  );

  view.rerender(
    React.createElement(views.OpsWorkView, {
      ...props,
      states: { search: { status: "pending" } },
    }),
  );
  assert.ok(view.getByText("Search is loading."));
  view.rerender(
    React.createElement(views.OpsWorkView, {
      ...props,
      states: {
        search: {
          status: "ready",
          items: [],
          revision: 1,
          refreshed: false,
        },
      },
    }),
  );
  assert.ok(view.getByText("No search results."));
  view.rerender(
    React.createElement(views.OpsWorkView, {
      ...props,
      collections,
      states: {
        search: {
          status: "ready",
          items: collections.search,
          revision: 1,
          refreshed: false,
        },
      },
    }),
  );
  assert.ok(view.getByText("All focused tests passed"));
});

test("mobile work picker traps focus, restores trigger, and exposes 44px tabs", async () => {
  assert.equal(typeof views.OpsWorkView, "function");
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "mobile",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  const trigger = view.getByRole("button", { name: "Choose work" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = view.getByRole("dialog", { name: "Choose work" });
  await waitFor(() => assert.ok(document.activeElement === dialog));
  fireEvent.keyDown(window, { key: "Tab" });
  assert.ok(dialog.contains(document.activeElement));
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  fireEvent.focusIn(outside);
  await waitFor(() => assert.ok(dialog.contains(document.activeElement)));
  outside.remove();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => assert.ok(document.activeElement === trigger));
  for (const tab of ["Plan", "Attention", "Evidence"]) {
    const tabControl = view.getByRole("tab", { name: tab });
    assert.equal(
      tabControl.getAttribute("style"),
      "min-height: 44px; min-width: 44px;",
    );
    assert.ok(tabControl.getAttribute("aria-controls"));
  }
  assert.ok(view.getByRole("tabpanel"));
});

test("mobile Work tabs rove focus and selection with arrow, Home, and End keys", () => {
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "mobile",
      onSearch() {},
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  const plan = view.getByRole("tab", { name: "Plan" });
  const attention = view.getByRole("tab", { name: "Attention" });
  const evidence = view.getByRole("tab", { name: "Evidence" });
  assert.equal(plan.tabIndex, 0);
  assert.equal(attention.tabIndex, -1);
  assert.equal(evidence.tabIndex, -1);

  plan.focus();
  fireEvent.keyDown(plan, { key: "ArrowRight" });
  assert.ok(document.activeElement === attention);
  assert.equal(attention.getAttribute("aria-selected"), "true");

  fireEvent.keyDown(attention, { key: "End" });
  assert.ok(document.activeElement === evidence);
  assert.equal(evidence.getAttribute("aria-selected"), "true");

  fireEvent.keyDown(evidence, { key: "ArrowRight" });
  assert.ok(document.activeElement === plan);
  fireEvent.keyDown(plan, { key: "ArrowLeft" });
  assert.ok(document.activeElement === evidence);
  fireEvent.keyDown(evidence, { key: "Home" });
  assert.ok(document.activeElement === plan);
  assert.equal(plan.getAttribute("aria-selected"), "true");
});

test("empty search stays local and never reaches the strict search module", () => {
  assert.equal(typeof views.OpsWorkView, "function");
  const searches = [];
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "desktop",
      onSearch: (scope) => searches.push(scope),
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Search" }));
  assert.deepEqual(searches, []);
  assert.ok(view.getByText("Enter a search query."));
});

test("rejected unsafe search stays local and never echoes the input", () => {
  const view = render(
    React.createElement(views.OpsWorkView, {
      collections,
      layout: "desktop",
      onSearch: () => false,
      onSelectWork() {},
      selectedWorkId: "work:a",
    }),
  );
  const unsafe = "file:///Users/private/secret";
  fireEvent.change(view.getByRole("searchbox", { name: "Search work" }), {
    target: { value: unsafe },
  });
  fireEvent.click(view.getByRole("button", { name: "Search" }));
  assert.ok(view.getByText("Search input is not accepted."));
  assert.equal(view.queryByText(unsafe), null);
});

test("true ready-empty and unavailable states have distinct copy", () => {
  assert.equal(typeof views.OpsCollectionState, "function");
  const empty = render(
    React.createElement(views.OpsCollectionState, {
      label: "Work",
      state: { status: "ready", items: [], revision: 1, refreshed: false },
    }),
  );
  assert.ok(empty.getByText("No work is active."));
  empty.unmount();
  const unavailable = render(
    React.createElement(views.OpsCollectionState, {
      label: "Work",
      state: { status: "unavailable" },
    }),
  );
  assert.ok(unavailable.getByText("Work is unavailable."));
});
