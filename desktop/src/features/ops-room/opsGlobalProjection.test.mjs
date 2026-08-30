import assert from "node:assert/strict";
import { test } from "node:test";

import * as projection from "./opsProjection.ts";

const work = (id, status = "active") => ({
  id,
  project_id: "project:raou",
  title: id === "work:a" ? "Ship Home and Work" : "Review evidence",
  status,
  progress: id === "work:a" ? 0.6 : 0.2,
  last_activity_at: "2026-08-30T10:00:00Z",
  session_count: 1,
  approval_count: 1,
  artifact_count: 2,
});
const collections = {
  workItems: [work("work:a"), work("work:b", "blocked")],
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
      id: "check:two",
      work_item_id: "work:a",
      key: "2",
      title: "Second canonical step",
      order: 2,
      origin: "agent_plan",
      status: "todo",
      evidence_ids: [],
      claimed_by_session_id: null,
      claimed_at: null,
      stage: "build",
      next_action: "Run the suite",
      depends_on: ["check:one"],
      updated_at: "2026-08-30T10:00:00Z",
      revision: 1,
    },
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
      next_action: null,
      depends_on: [],
      updated_at: "2026-08-30T09:00:00Z",
      revision: 1,
    },
  ],
  decisions: [
    {
      id: "decision:a",
      work_item_id: "work:a",
      source: "checklist",
      source_id: "check:two",
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
      artifact_id: null,
      artifact_version: null,
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

test("work selection survives refresh and falls back in canonical order", () => {
  assert.equal(typeof projection.reconcileOpsWorkSelection, "function");
  assert.equal(
    projection.reconcileOpsWorkSelection("work:b", collections.workItems),
    "work:b",
  );
  assert.equal(
    projection.reconcileOpsWorkSelection("work:removed", collections.workItems),
    "work:a",
  );
  assert.equal(projection.reconcileOpsWorkSelection("work:a", []), null);
});

test("Home projects an operational pulse without a fabricated checklist total", () => {
  assert.equal(typeof projection.projectOpsHome, "function");
  const home = projection.projectOpsHome(collections);
  assert.deepEqual(
    home.attention.map(({ id }) => id),
    ["work:b", "decision:a", "approval:a"],
  );
  assert.equal(home.activeSessions[0].id, "codex_direct:session-a");
  assert.equal("checklist" in home, false);
  assert.equal("checklistTotal" in home, false);
  assert.equal(home.recentEvidence[0].id, "evidence:a");
  assert.equal(home.recentAudit[0].id, "audit:a");
});

test("Work filters every global page to selection and keeps checklist canonical", () => {
  assert.equal(typeof projection.projectOpsWork, "function");
  const detail = projection.projectOpsWork(collections, "work:a");
  assert.equal(detail.workItem.id, "work:a");
  assert.deepEqual(
    detail.checklist.map(({ id }) => id),
    ["check:one", "check:two"],
  );
  assert.deepEqual(
    detail.sessions.map(({ id }) => id),
    ["codex_direct:session-a"],
  );
  assert.deepEqual(
    detail.decisions.map(({ id }) => id),
    ["decision:a"],
  );
  assert.deepEqual(
    detail.approvals.map(({ id }) => id),
    ["approval:a"],
  );
  assert.deepEqual(
    detail.evidence.map(({ id }) => id),
    ["evidence:a"],
  );
  assert.deepEqual(
    detail.audit.map(({ id }) => id),
    ["audit:a"],
  );
});

test("search request preserves the exact input and closed kind/work scope", () => {
  assert.equal(typeof projection.opsSearchRequest, "function");
  assert.deepEqual(
    projection.opsSearchRequest("  exact Query  ", "evidence", "work:a"),
    {
      module: "search",
      scope: {
        q: "  exact Query  ",
        kind: "evidence",
        work: "work:a",
        sort: "rank_desc_then_observed_at_desc",
      },
    },
  );
});

test("query identity isolates capability, selection, and exact search races", () => {
  assert.equal(typeof projection.opsGlobalQueryIdentity, "function");
  const base = projection.opsGlobalQueryIdentity("search", 3, {
    q: "Alpha",
    work: "work:a",
  });
  assert.notDeepEqual(
    base,
    projection.opsGlobalQueryIdentity("search", 4, {
      q: "Alpha",
      work: "work:a",
    }),
  );
  assert.notDeepEqual(
    base,
    projection.opsGlobalQueryIdentity("search", 3, {
      q: "alpha",
      work: "work:b",
    }),
  );
});
