import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  atob: dom.window.atob.bind(dom.window),
  Blob: dom.window.Blob,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom.window,
});
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const { OpsConnectionsView, OpsKnowledgeView, OpsRoutingView, OpsSafetyView } =
  await import("./OpsSourceViews.tsx");

afterEach(cleanup);
after(() => dom.window.close());

const generated_at = "2026-08-30T10:00:00Z";
const ready = (items) => ({
  status: "ready",
  items,
  revision: 7,
  refreshed: false,
});
const evidence = {
  id: "evidence:a",
  work_item_id: "work:a",
  kind: "test_report",
  status: "verified",
  observed_at: generated_at,
  artifact_id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  artifact_version: 1,
};
const audit = {
  id: "audit:a",
  work_item_id: "work:a",
  kind: "review.approved",
  summary: "Review evidence accepted",
  observed_at: generated_at,
};

function renderWithQuery(element) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(React.createElement(QueryClientProvider, { client }, element));
}

test("Knowledge keeps signed research visible beside isolated evidence state and opens evidence in the native reader", async () => {
  renderWithQuery(
    React.createElement(OpsKnowledgeView, {
      evidence: ready([evidence]),
      research: ready([
        {
          id: "research:a",
          title: "Reader, Come Home",
          status: "complete",
          updated_at: generated_at,
        },
      ]),
      loadArtifact: async () => ({
        kind: "inline_text",
        contract_version: 1,
        artifact_id: evidence.artifact_id,
        version: 1,
        representation: "preview",
        mime: "text/markdown",
        total_size: 17,
        sha256: "a".repeat(64),
        text: "Verified research",
      }),
    }),
  );

  assert.ok(screen.getByRole("heading", { name: "Knowledge" }));
  assert.ok(screen.getByText("Reader, Come Home"));
  fireEvent.click(screen.getByRole("button", { name: /Open evidence/ }));
  await waitFor(() => assert.ok(screen.getByText("Verified research")));
  assert.ok(screen.getByRole("dialog", { name: "evidence:a" }));
});

test("Connections combines native health and repository rows with an honest inbound-only Teams placeholder", () => {
  render(
    React.createElement(OpsConnectionsView, {
      connections: {
        status: "ready",
        data: [
          {
            id: "connection:hub",
            name: "Local Hub",
            status: "ready",
            updated_at: generated_at,
          },
        ],
      },
      health: { hub: "ready", orca: "connected", codex: "connected" },
      repositories: ready([
        {
          id: "repository:a",
          name: "buzz-fork-wrapper",
          branch: "feat/native-ops-wrapper",
          clean: true,
          ahead: 0,
          behind: 0,
        },
      ]),
      sessions: ready([]),
    }),
  );
  assert.ok(screen.getByText("Local Hub"));
  assert.ok(screen.getByText("buzz-fork-wrapper"));
  assert.ok(screen.getByRole("heading", { name: "Microsoft Teams" }));
  assert.ok(screen.getByText(/not configured/i));
  assert.ok(screen.getByText(/read-only inbound/i));
});

test("Routing renders the existing projection and audit while its native Workflows link stays explicit", () => {
  let opened = false;
  render(
    React.createElement(OpsRoutingView, {
      audit: ready([audit]),
      onOpenWorkflows() {
        opened = true;
      },
      workflowRouting: {
        status: "ready",
        data: {
          status: "ready",
          routes: [{ from: "controller", to: "codex", effort: "high" }],
        },
      },
    }),
  );
  assert.ok(screen.getByText("controller → codex"));
  assert.ok(screen.getByText("Review evidence accepted"));
  fireEvent.click(screen.getByRole("button", { name: "Open Workflows" }));
  assert.equal(opened, true);
  assert.equal(screen.queryByRole("button", { name: /edit|execute/i }), null);
});

test("Safety exposes approval, audit, and contract health without mounting mutation controls", () => {
  render(
    React.createElement(OpsSafetyView, {
      approvals: ready([
        {
          id: "approval:a",
          work_item_id: "work:a",
          action_kind: "provider_run",
          status: "pending_approval",
          hold_reason: "Needs review",
          risk_class: ["dispatch_create"],
          updated_at: generated_at,
          revision: 1,
        },
      ]),
      audit: ready([audit]),
      moduleStates: {
        evidence: { status: "contract_invalid" },
        audit: { status: "ready", data: [] },
      },
      mutationsDisabled: true,
    }),
  );
  assert.ok(screen.getByText("pending_approval"));
  assert.ok(screen.getByText("evidence · contract_invalid"));
  assert.ok(screen.getByText(/read-only safety boundary/i));
  assert.equal(
    screen.queryAllByRole("button", {
      name: /approve|reject|execute|deliver|send/i,
    }).length,
    0,
  );
});

test("one source failure stays local while sibling source data remains visible", () => {
  render(
    React.createElement(OpsKnowledgeView, {
      evidence: { status: "contract_invalid" },
      research: ready([
        { id: "research:a", title: "Still visible", status: "complete" },
      ]),
    }),
  );
  assert.ok(screen.getByText("Evidence contract is invalid."));
  assert.ok(screen.getByText("Still visible"));
});

test("a source transport failure is explicit without hiding its sibling", () => {
  let retries = 0;
  render(
    React.createElement(OpsKnowledgeView, {
      evidence: { status: "disconnected" },
      onRetryEvidence: () => {
        retries += 1;
      },
      research: ready([
        { id: "research:a", title: "Still visible", status: "complete" },
      ]),
    }),
  );
  assert.ok(screen.getByText("Evidence is disconnected."));
  assert.ok(screen.getByText("Still visible"));
  fireEvent.click(screen.getByRole("button", { name: "Retry Evidence" }));
  assert.equal(retries, 1);
});

test("ready source siblings remain visible beside collection-local pending states", () => {
  const view = render(
    React.createElement(OpsKnowledgeView, {
      evidence: { status: "pending" },
      research: ready([
        { id: "research:a", title: "Ready research", status: "complete" },
      ]),
    }),
  );
  assert.ok(screen.getByText("Ready research"));
  assert.ok(screen.getByText("Loading evidence…"));
  view.unmount();

  render(
    React.createElement(OpsConnectionsView, {
      connections: { status: "unavailable" },
      health: { hub: "degraded", orca: "unavailable", codex: "unavailable" },
      repositories: ready([
        {
          id: "repository:a",
          name: "Ready repository",
          branch: "main",
          clean: true,
          ahead: 0,
          behind: 0,
        },
      ]),
      sessions: { status: "pending" },
    }),
  );
  assert.ok(screen.getByText("Ready repository"));
  assert.ok(screen.getByText("Loading sessions…"));
});

test("ready-empty connection rows render explicit empty copy", () => {
  render(
    React.createElement(OpsConnectionsView, {
      connections: { status: "ready", data: [] },
      health: { hub: "ready", orca: "ready", codex: "ready" },
      repositories: ready([]),
      sessions: ready([]),
    }),
  );
  assert.ok(screen.getByText("No source connections."));
  assert.ok(screen.getByText("No repository observations."));
});
