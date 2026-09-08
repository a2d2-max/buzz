import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  applyIssueStatusOverlay,
  issueConfirmsOverlay,
  settleIssueStatusOverlays,
} from "./issueStatusOverlay.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function issue(overrides = {}) {
  return {
    id: "d".repeat(64),
    status: "Backlog",
    statusCreatedAt: null,
    title: "Ship the board",
    ...overrides,
  };
}

test("applying an overlay replaces both the status and its timestamp", () => {
  const overlaid = applyIssueStatusOverlay(issue(), {
    status: "Triage",
    statusCreatedAt: 1_700,
  });
  assert.equal(overlaid.status, "Triage");
  assert.equal(overlaid.statusCreatedAt, 1_700);
  assert.equal(overlaid.title, "Ship the board");
});

test("the relay confirms an overlay only with a status at least as new", () => {
  const overlay = { status: "Triage", statusCreatedAt: 1_700 };
  assert.equal(issueConfirmsOverlay(issue(), overlay), false, "no status yet");
  assert.equal(
    issueConfirmsOverlay(issue({ statusCreatedAt: 1_699 }), overlay),
    false,
    "older status",
  );
  assert.equal(
    issueConfirmsOverlay(issue({ statusCreatedAt: 1_700 }), overlay),
    true,
    "the published event itself",
  );
  assert.equal(
    issueConfirmsOverlay(
      issue({ status: "Done", statusCreatedAt: 1_701 }),
      overlay,
    ),
    true,
    "a later status from anyone is authoritative",
  );
});

test("settling drops confirmed overlays and keeps the rest, stably", () => {
  const overlays = {
    ["1".repeat(64)]: { status: "Triage", statusCreatedAt: 1_700 },
    ["2".repeat(64)]: { status: "Done", statusCreatedAt: 1_800 },
  };
  const stale = [
    issue({ id: "1".repeat(64), statusCreatedAt: 1_600 }),
    issue({ id: "2".repeat(64) }),
  ];
  assert.equal(
    settleIssueStatusOverlays(overlays, stale),
    overlays,
    "nothing confirmed: same object back",
  );

  const settled = settleIssueStatusOverlays(overlays, [
    issue({ id: "1".repeat(64), status: "Triage", statusCreatedAt: 1_700 }),
    issue({ id: "2".repeat(64) }),
  ]);
  assert.deepEqual(Object.keys(settled), ["2".repeat(64)]);
});

async function renderOverlays(initialIssues) {
  const { renderHook } = await import("@testing-library/react");
  const { useIssueStatusOverlays } = await import("./issueStatusOverlay.ts");
  const rendered = renderHook(({ issues }) => useIssueStatusOverlays(issues), {
    initialProps: { issues: initialIssues },
  });
  return rendered;
}

test("a move shows at once and its timestamp outranks the relay's copy", async () => {
  const { act } = await import("@testing-library/react");
  const relayCopy = issue({ statusCreatedAt: 1_700 });
  const { result } = await renderOverlays([relayCopy]);

  let createdAt;
  act(() => {
    createdAt = result.current.begin(relayCopy, "Triage", 1_000);
  });
  assert.equal(createdAt, 1_701, "one past the relay's status, not the clock");
  const shown = result.current.apply(relayCopy);
  assert.equal(shown.status, "Triage");
  assert.equal(shown.statusCreatedAt, 1_701);
});

test("a second move on the same card outranks the first, even within one second", async () => {
  const { act } = await import("@testing-library/react");
  const relayCopy = issue();
  const { result } = await renderOverlays([relayCopy]);

  let first;
  let second;
  act(() => {
    first = result.current.begin(relayCopy, "Triage", 1_000);
  });
  // The board hands the overlaid card to the next drop, exactly as it renders it.
  act(() => {
    second = result.current.begin(
      result.current.apply(relayCopy),
      "Done",
      1_000,
    );
  });
  assert.equal(first, 1_000);
  assert.equal(second, 1_001);
  assert.equal(result.current.apply(relayCopy).status, "Done");
});

test("the overlay survives a stale refetch and yields to a confirming one", async () => {
  const { act } = await import("@testing-library/react");
  const relayCopy = issue();
  const { rerender, result } = await renderOverlays([relayCopy]);

  let createdAt;
  act(() => {
    createdAt = result.current.begin(relayCopy, "Triage", 1_000);
  });

  // A refetch that raced ahead of the relay's indexing brings the old copy.
  rerender({ issues: [issue()] });
  assert.equal(result.current.apply(issue()).status, "Triage");

  // The relay now carries a status at least as new: its copy wins, whatever
  // it says — here somebody else moved the card on after us.
  const confirmed = issue({ status: "Done", statusCreatedAt: createdAt + 5 });
  rerender({ issues: [confirmed] });
  assert.equal(result.current.apply(confirmed).status, "Done");
  assert.equal(result.current.apply(confirmed), confirmed, "no overlay left");
});

test("rolling back removes only the move that failed", async () => {
  const { act } = await import("@testing-library/react");
  const relayCopy = issue();
  const { result } = await renderOverlays([relayCopy]);

  let first;
  let second;
  act(() => {
    first = result.current.begin(relayCopy, "Triage", 1_000);
  });
  act(() => {
    second = result.current.begin(
      result.current.apply(relayCopy),
      "Done",
      1_000,
    );
  });

  // The first publish fails after the second drop took over the card.
  act(() => {
    result.current.rollBack(relayCopy.id, first);
  });
  assert.equal(result.current.apply(relayCopy).status, "Done");

  act(() => {
    result.current.rollBack(relayCopy.id, second);
  });
  assert.equal(result.current.apply(relayCopy).status, "Backlog");
});
