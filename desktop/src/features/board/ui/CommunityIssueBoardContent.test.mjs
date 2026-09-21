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
  // jsdom gives every element a zero rect, which makes every dnd-kit
  // collision a tie. Lay the columns out left to right so a drag lands.
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
const STRANGER = "c".repeat(64);
const ISSUE_ID = "d".repeat(64);

const repository = {
  channelId: null,
  contributors: [],
  id: `30617:${OWNER}:demo`,
  name: "demo",
  owner: OWNER,
  repoAddress: `30617:${OWNER}:demo`,
};

const project = {
  id: "project-demo",
  name: "Demo project",
  repositories: [repository],
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
  repoAddress: repository.repoAddress,
  status: "Backlog",
  statusCreatedAt: null,
  statusEventId: null,
  tags: [],
  title: "Ship the board",
  updatedAt: 100,
};

function workItem(issue = backlogIssue) {
  return { issue, project, repository };
}

// A settled mutation is collected at once — React Query's default 5-minute
// mutation gc timer would otherwise hold the test process open.
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

function handleOf(container) {
  return container.querySelector(
    "[data-testid='project-issue-board-drag-handle']",
  );
}

/** Drive a full keyboard drag: pick up, step `steps` columns right, drop. */
async function keyboardDrag(handle, steps) {
  const { act, fireEvent } = await import("@testing-library/react");
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  for (let step = 0; step < steps; step += 1) {
    fireEvent.keyDown(handle, { code: "ArrowRight", key: "ArrowRight" });
    await act(async () => {});
  }
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
}

/** Let the sign → publish → settle chain run through its microtask hops. */
async function settle() {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function installTauriInvoke(t, invoke) {
  const prior = globalThis.window.__TAURI_INTERNALS__;
  t.after(() => {
    globalThis.window.__TAURI_INTERNALS__ = prior;
  });
  globalThis.window.__TAURI_INTERNALS__ = { invoke };
}

/** Records signing requests and answers each with a signed-looking event. */
function installSigner(t) {
  const signed = [];
  installTauriInvoke(t, (command, args) => {
    if (command !== "sign_event") return Promise.resolve([]);
    signed.push(args);
    return Promise.resolve(
      JSON.stringify({
        content: args.content,
        created_at: args.createdAt,
        id: "f".repeat(64),
        kind: args.kind,
        pubkey: AUTHOR,
        sig: "",
        tags: args.tags,
      }),
    );
  });
  return signed;
}

async function stubPublish(t, publishEvent) {
  const { relayClient } = await import("@/shared/api/relayClient");
  const ownBefore = Object.hasOwn(relayClient, "publishEvent");
  const prior = relayClient.publishEvent;
  t.after(() => {
    if (ownBefore) relayClient.publishEvent = prior;
    else delete relayClient.publishEvent;
  });
  relayClient.publishEvent = publishEvent;
}

async function renderContent(t, overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { CommunityIssueBoardContent } = await import(
    "./CommunityIssueBoardContent.tsx"
  );
  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  t.after(() => queryClient.clear());
  const props = {
    error: null,
    failedSections: [],
    hasRepositories: true,
    isRetrying: false,
    managedAgentPubkeys: new Set(),
    onRetry: () => {},
    onSelectedIssueIdChange: () => {},
    profiles: undefined,
    selectedIssueId: null,
    viewer: AUTHOR,
    workItems: [workItem()],
    ...overrides,
  };
  const ui = (nextProps) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunityIssueBoardContent, nextProps),
    );
  const rendered = render(ui(props));
  return {
    ...rendered,
    rerenderWith: (next) => rendered.rerender(ui({ ...props, ...next })),
  };
}

test("missing statuses lock every card and say why, even for the author", async (t) => {
  const { STATUSES_UNAVAILABLE_MOVE_LOCK } = await import(
    "./CommunityIssueBoardContent.tsx"
  );
  const { container } = await renderContent(t, {
    failedSections: ["statuses"],
  });

  assert.equal(columnOf(container, ISSUE_ID), "Backlog");
  assert.equal(handleOf(container), null, "no drag handle for the author");
  const hints = container.querySelectorAll(
    "[data-testid='project-issue-board-column-locked']",
  );
  assert.equal(hints.length, BOARD_ORDER.length);
  assert.ok(
    [...hints].every(
      (hint) => hint.textContent === STATUSES_UNAVAILABLE_MOVE_LOCK,
    ),
  );
  const notice = container.querySelector("[role='alert']");
  assert.match(notice?.textContent ?? "", /statuses/);
});

test("the author gets a drag handle and a stranger does not", async (t) => {
  const asAuthor = await renderContent(t);
  assert.ok(handleOf(asAuthor.container));
  asAuthor.unmount();

  const asStranger = await renderContent(t, { viewer: STRANGER });
  assert.equal(handleOf(asStranger.container), null);
});

test("an optimistic move holds through a stale refetch and yields to a confirming one", async (t) => {
  const signed = installSigner(t);
  await stubPublish(t, async () => {});
  const { container, rerenderWith } = await renderContent(t);

  await keyboardDrag(handleOf(container), 1);
  assert.equal(columnOf(container, ISSUE_ID), "Triage", "shown at once");
  await settle();

  assert.equal(signed.length, 1);
  const [{ createdAt, tags }] = signed;
  assert.deepEqual(
    tags.find((tag) => tag[0] === "a"),
    ["a", repository.repoAddress],
    "published against the card's own repository",
  );

  // A refetch that raced ahead of the relay's indexing brings the old copy
  // back — the card must not bounce to Backlog.
  rerenderWith({ workItems: [workItem({ ...backlogIssue })] });
  assert.equal(columnOf(container, ISSUE_ID), "Triage");

  // The relay now carries a status at least as new as ours: its copy wins,
  // whatever it says.
  rerenderWith({
    workItems: [
      workItem({
        ...backlogIssue,
        status: "Done",
        statusCreatedAt: createdAt,
      }),
    ],
  });
  assert.equal(columnOf(container, ISSUE_ID), "Done");
});

test("a second drop before the first settles publishes a strictly newer timestamp", async (t) => {
  // A status timestamp far in the future keeps the clock out of the
  // arithmetic: each drop must land exactly one second past the last one.
  const LAST_STATUS = 4_000_000_000;
  const signed = installSigner(t);
  // Neither publish settles until the end, so both overlays stay in flight.
  let releasePublishes;
  const publishing = new Promise((resolve) => {
    releasePublishes = resolve;
  });
  await stubPublish(t, () => publishing);
  const { container } = await renderContent(t, {
    workItems: [workItem({ ...backlogIssue, statusCreatedAt: LAST_STATUS })],
  });

  await keyboardDrag(handleOf(container), 1);
  assert.equal(columnOf(container, ISSUE_ID), "Triage");
  // Triage → Done crosses the two label-only columns.
  await keyboardDrag(handleOf(container), 3);
  assert.equal(columnOf(container, ISSUE_ID), "Done");
  await settle();

  assert.deepEqual(
    signed.map((request) => [request.kind, request.createdAt]),
    [
      [1633, LAST_STATUS + 1],
      [1631, LAST_STATUS + 2],
    ],
  );

  releasePublishes();
  await settle();
});

test("a failed publish rolls the card back and reports", async (t) => {
  const { toast } = await import("sonner");
  const priorToastError = toast.error;
  t.after(() => {
    toast.error = priorToastError;
  });
  const toasts = [];
  toast.error = (message) => {
    toasts.push(message);
    return 0;
  };
  // Hold the signing step open so the optimistic state can be observed before
  // the write fails.
  let failSigning;
  const signing = new Promise((_resolve, reject) => {
    failSigning = reject;
  });
  installTauriInvoke(t, (command) =>
    command === "sign_event" ? signing : Promise.resolve([]),
  );
  const { container } = await renderContent(t);

  await keyboardDrag(handleOf(container), 1);
  assert.equal(columnOf(container, ISSUE_ID), "Triage");

  failSigning(new Error("Failed to update task status."));
  await settle();

  assert.equal(columnOf(container, ISSUE_ID), "Backlog");
  assert.deepEqual(toasts, ["Failed to update task status."]);
});

test("a selected task that is not on the board falls through to the board", async (t) => {
  const { container } = await renderContent(t, {
    selectedIssueId: "9".repeat(64),
  });

  assert.ok(container.querySelector("[data-testid='project-issue-board']"));
  assert.equal(
    container.querySelector("[data-testid='community-board-back']"),
    null,
  );
});

test("issue list intersects search, project, status and assignee filters without losing detail selection", async (t) => {
  const { fireEvent } = await import("@testing-library/react");
  const opened = [];
  const other = {
    ...workItem({
      ...backlogIssue,
      id: "e".repeat(64),
      title: "Other issue",
      status: "Done",
      assignees: [OWNER],
    }),
    project: { ...project, id: "other-project", name: "Other project" },
  };
  const ui = await renderContent(t, {
    workItems: [
      workItem({ ...backlogIssue, content: "release checklist" }),
      other,
    ],
    onSelectedIssueIdChange: (id) => opened.push(id),
  });
  fireEvent.click(ui.getByRole("button", { name: "Issue list view" }));
  fireEvent.change(ui.getByRole("searchbox", { name: "Search issues" }), {
    target: { value: "checklist" },
  });
  assert.equal(ui.queryByRole("button", { name: "Open Other issue" }), null);
  fireEvent.change(ui.getByLabelText("Issue status"), {
    target: { value: "Backlog" },
  });
  fireEvent.change(ui.getByLabelText("Issue assignee"), {
    target: { value: "unassigned" },
  });
  fireEvent.change(ui.getByLabelText("Issue project"), {
    target: { value: "project-demo" },
  });
  fireEvent.click(ui.getByRole("button", { name: "Open Ship the board" }));
  assert.deepEqual(opened, [ISSUE_ID]);
  fireEvent.change(ui.getByLabelText("Issue status"), {
    target: { value: "Done" },
  });
  assert.ok(ui.getByText("No matching issues"));
  fireEvent.click(ui.getByRole("button", { name: "Clear issue filters" }));
  assert.ok(ui.getByRole("button", { name: "Open Other issue" }));
});
