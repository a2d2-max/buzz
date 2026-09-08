import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const COLUMN_STEP = 268;
const COLUMN_WIDTH = 250;
const BOARD_ORDER = [
  "Backlog",
  "Triage",
  "In Progress",
  "In Review",
  "Done",
  "Closed",
];

function rect(x, y, width, height) {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON() {},
    top: y,
    width,
    x,
    y,
  };
}

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = dom.window.ResizeObserver;
  // Unref'd: a pending animation frame must not hold the test process open.
  globalThis.requestAnimationFrame = (callback) => {
    const handle = setTimeout(callback, 0);
    handle.unref?.();
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const self =
      this.dataset.testid === "project-issue-board-drag-overlay"
        ? dom.window.document.querySelector('[data-drag-state="dragging"]')
        : this;
    if (!self) return rect(0, 0, 0, 0);
    const owner = self.closest("[data-status]");
    const index = owner ? BOARD_ORDER.indexOf(owner.dataset.status) : -1;
    if (index < 0) return rect(0, 0, 0, 0);
    const left = index * COLUMN_STEP;
    return self.dataset.testid === "project-issue-board-card"
      ? rect(left + 5, 50, COLUMN_WIDTH - 10, 40)
      : rect(left, 0, COLUMN_WIDTH, 400);
  };
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const ISSUE_ID = "d".repeat(64);

const project = {
  channelId: null,
  contributors: [],
  id: `30617:${OWNER}:demo`,
  name: "demo",
  owner: OWNER,
  repoAddress: `30617:${OWNER}:demo`,
};

const backlogIssue = {
  assigneeOperationHeads: {},
  assignees: [],
  author: AUTHOR,
  category: "issue",
  channelId: null,
  comments: [],
  content: "",
  createdAt: 100,
  id: ISSUE_ID,
  labels: [],
  originAgentName: null,
  recipients: [],
  repoAddress: project.repoAddress,
  status: "Backlog",
  statusCreatedAt: null,
  statusEventId: null,
  tags: [],
  title: "Ship the board",
  updatedAt: 100,
};

// Seeded caches never refetch, and a settled mutation is collected at once —
// React Query's default 5-minute mutation gc timer would otherwise hold the
// test process open long after the assertions are done.
const TEST_QUERY_DEFAULTS = {
  mutations: { gcTime: 0, retry: false },
  queries: {
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  },
};

function columnOf(container, issueId) {
  const card = container.querySelector(`[data-issue-id="${issueId}"]`);
  return card?.closest("[data-status]")?.dataset.status ?? null;
}

/** Pick the card up, step one column right, drop it. */
async function dragOneColumnRight(container) {
  const { act, fireEvent } = await import("@testing-library/react");
  const handle = container.querySelector(
    "[data-testid='project-issue-board-drag-handle']",
  );
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  fireEvent.keyDown(handle, { code: "ArrowRight", key: "ArrowRight" });
  await act(async () => {});
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
}

test("an optimistic move rolls back and reports when the publish fails", async (t) => {
  const { createElement } = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { managedAgentsQueryKey } = await import("@/features/agents/hooks");
  const { toast } = await import("sonner");
  const { ProjectIssueBoardPanel } = await import(
    "./ProjectIssueBoardPanel.tsx"
  );

  const priorWindow = globalThis.window;
  const priorToastError = toast.error;
  t.after(() => {
    toast.error = priorToastError;
    globalThis.window = priorWindow;
  });

  const toasts = [];
  toast.error = (message) => {
    toasts.push(message);
    return 0;
  };

  // Hold the signing step open so the optimistic state can be observed before
  // the write resolves either way.
  let failSigning;
  const signing = new Promise((_resolve, reject) => {
    failSigning = reject;
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (command) =>
      command === "sign_event" ? signing : Promise.resolve([]),
  };

  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  t.after(() => queryClient.clear());
  // The viewer is the task author, so they may move their own card.
  queryClient.setQueryData(["identity"], { pubkey: AUTHOR });
  queryClient.setQueryData(managedAgentsQueryKey, []);
  queryClient.setQueryData(["project", project.id, "issues"], [backlogIssue]);

  const { container } = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectIssueBoardPanel, {
        onSelectedIssueIdChange: () => {},
        project,
        selectedIssueId: null,
      }),
    ),
  );

  assert.equal(columnOf(container, ISSUE_ID), "Backlog");

  await dragOneColumnRight(container);
  // Optimistic: the card is already in Triage while the write is in flight.
  assert.equal(columnOf(container, ISSUE_ID), "Triage");
  assert.deepEqual(toasts, []);

  failSigning(new Error("Failed to update task status."));
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(columnOf(container, ISSUE_ID), "Backlog");
  assert.deepEqual(toasts, ["Failed to update task status."]);
});

test("a viewer who is neither author nor owner gets no drag handles", async (t) => {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { managedAgentsQueryKey } = await import("@/features/agents/hooks");
  const { ProjectIssueBoardPanel } = await import(
    "./ProjectIssueBoardPanel.tsx"
  );

  const priorWindow = globalThis.window;
  t.after(() => {
    globalThis.window = priorWindow;
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve([]),
  };

  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  t.after(() => queryClient.clear());
  queryClient.setQueryData(["identity"], { pubkey: "c".repeat(64) });
  queryClient.setQueryData(managedAgentsQueryKey, []);
  queryClient.setQueryData(["project", project.id, "issues"], [backlogIssue]);

  const { container } = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectIssueBoardPanel, {
        onSelectedIssueIdChange: () => {},
        project,
        selectedIssueId: null,
      }),
    ),
  );

  assert.equal(columnOf(container, ISSUE_ID), "Backlog");
  assert.equal(
    container.querySelectorAll(
      "[data-testid='project-issue-board-drag-handle']",
    ).length,
    0,
  );
});
