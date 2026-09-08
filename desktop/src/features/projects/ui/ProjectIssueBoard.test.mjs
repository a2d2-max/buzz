import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

/** Column width used by the fake layout; matches the board's COLUMN_STEP_PX. */
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

/**
 * jsdom gives every element a zero rect, which makes every dnd-kit collision a
 * tie. Lay the columns out left to right and put each card inside its column
 * so a drag has somewhere real to land.
 */
function installFakeLayout(window) {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    // dnd-kit measures the drag overlay, not the source card, once an overlay
    // is rendered. In a browser the overlay sits exactly over the card it
    // replaced, so report the card's box for it.
    const self =
      this.dataset.testid === "project-issue-board-drag-overlay"
        ? window.document.querySelector('[data-drag-state="dragging"]')
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
  // dnd-kit needs these; jsdom ships none of them.
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = dom.window.ResizeObserver;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
  dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
  // Unref'd: a pending animation frame must not hold the test process open.
  globalThis.requestAnimationFrame = (callback) => {
    const handle = setTimeout(callback, 0);
    handle.unref?.();
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  installFakeLayout(dom.window);
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);

const project = {
  channelId: null,
  contributors: [],
  id: "30617:owner:demo",
  name: "demo",
  owner: OWNER,
  repoAddress: `30617:${OWNER}:demo`,
};

function issue(seed, status) {
  return {
    assigneeOperationHeads: {},
    assignees: [],
    author: AUTHOR,
    category: "issue",
    channelId: null,
    comments: [],
    content: "",
    createdAt: 100,
    id: seed.repeat(64).slice(0, 64),
    labels: [],
    originAgentName: null,
    recipients: [],
    repoAddress: project.repoAddress,
    status,
    statusCreatedAt: null,
    statusEventId: null,
    tags: [],
    title: `Task ${status}`,
    updatedAt: 100,
  };
}

const ITEMS = [
  { issue: issue("1", "In Review"), project },
  { issue: issue("2", "In Progress"), project },
  { issue: issue("3", "Triage"), project },
  { issue: issue("4", "Backlog"), project },
  { issue: issue("5", "Done"), project },
  { issue: issue("6", "Closed"), project },
];

function itemFor(status) {
  return ITEMS.find((item) => item.issue.status === status);
}

async function renderBoard(overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { ProjectIssueBoard } = await import("./ProjectIssueBoard.tsx");
  const moves = [];
  const result = render(
    createElement(ProjectIssueBoard, {
      canMoveIssue: () => true,
      items: ITEMS,
      onMoveIssue: (item, status) => moves.push([item.issue.status, status]),
      onOpenIssue: () => {},
      ...overrides,
    }),
  );
  return { ...result, moves };
}

function handleFor(container, status) {
  return container.querySelector(
    `[data-status="${status}"] [data-testid='project-issue-board-drag-handle']`,
  );
}

/** Drive a full keyboard drag: pick up, step `steps` columns, drop. */
async function keyboardDrag(handle, steps) {
  const { act, fireEvent } = await import("@testing-library/react");
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  // dnd-kit only reads arrow keys once the drag context has measured, which
  // happens on the render after pickup — so settle between every press.
  await act(async () => {});
  for (let step = 0; step < Math.abs(steps); step += 1) {
    fireEvent.keyDown(handle, {
      code: steps > 0 ? "ArrowRight" : "ArrowLeft",
      key: steps > 0 ? "ArrowRight" : "ArrowLeft",
    });
    await act(async () => {});
  }
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
}

/** Drive a full pointer drag from `handle` to the middle of `toStatus`. */
async function pointerDrag(handle, toStatus) {
  const { act, fireEvent } = await import("@testing-library/react");
  const from = handle.getBoundingClientRect();
  const target = BOARD_ORDER.indexOf(toStatus) * COLUMN_STEP + COLUMN_WIDTH / 2;
  fireEvent.pointerDown(handle, {
    button: 0,
    clientX: from.left,
    clientY: from.top,
    isPrimary: true,
    pointerId: 1,
  });
  // Past the 6px activation constraint, then onto the target column.
  fireEvent.pointerMove(dom.window.document, {
    clientX: from.left + 20,
    clientY: from.top,
    isPrimary: true,
    pointerId: 1,
  });
  await act(async () => {});
  fireEvent.pointerMove(dom.window.document, {
    clientX: target,
    clientY: 200,
    isPrimary: true,
    pointerId: 1,
  });
  await act(async () => {});
  fireEvent.pointerUp(dom.window.document, {
    clientX: target,
    clientY: 200,
    isPrimary: true,
    pointerId: 1,
  });
  await act(async () => {});
}

test("renders one column per task status with its cards", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard();

  const columns = screen.getAllByTestId("project-issue-board-column");
  assert.deepEqual(
    columns.map((column) => column.getAttribute("data-status")),
    BOARD_ORDER,
  );

  for (const column of columns) {
    const status = column.getAttribute("data-status");
    const cards = [
      ...column.querySelectorAll("[data-testid='project-issue-board-card']"),
    ];
    assert.equal(cards.length, 1, status);
    assert.equal(
      cards[0].getAttribute("data-issue-id"),
      itemFor(status).issue.id,
    );
  }
});

test("opens the task the card stands for", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const opened = [];
  await renderBoard({ onOpenIssue: (item) => opened.push(item.issue.id) });

  const [column] = screen.getAllByTestId("project-issue-board-column");
  fireEvent.click(
    column.querySelector("[data-testid='project-issue-board-card-open']"),
  );
  assert.deepEqual(opened, [itemFor("Backlog").issue.id]);
});

test("a viewer who may not move tasks gets no drag handles", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard({ canMoveIssue: () => false });

  assert.equal(
    screen.queryAllByTestId("project-issue-board-drag-handle").length,
    0,
  );
  // The cards themselves stay readable and openable.
  assert.equal(screen.getAllByTestId("project-issue-board-card").length, 6);
});

test("a permitted viewer gets a labelled drag handle per card", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard();

  const handles = screen.getAllByTestId("project-issue-board-drag-handle");
  assert.equal(handles.length, 6);
  assert.deepEqual(
    handles.map((handle) => handle.getAttribute("aria-label")),
    BOARD_ORDER.map((status) => `Move Task ${status}`),
  );
  // The native button already carries the role; dnd-kit must not re-add it.
  assert.equal(handles[0].getAttribute("aria-roledescription"), "draggable");
});

test("a keyboard drag drops the card into the next column", async () => {
  const { container, moves } = await renderBoard();

  // Backlog (0) -> Triage (1).
  await keyboardDrag(handleFor(container, "Backlog"), 1);
  assert.deepEqual(moves, [["Backlog", "Triage"]]);
});

test("a keyboard drag can cross the label-only columns to Done", async () => {
  const { container, moves } = await renderBoard();

  // Triage (1) -> Done (4), stepping over In Progress and In Review.
  await keyboardDrag(handleFor(container, "Triage"), 3);
  assert.deepEqual(moves, [["Triage", "Done"]]);
});

test("a pointer drag drops the card into the column under the pointer", async () => {
  const { container, moves } = await renderBoard();

  await pointerDrag(handleFor(container, "Backlog"), "Closed");
  assert.deepEqual(moves, [["Backlog", "Closed"]]);
});

test("dropping on a label-only column does nothing", async () => {
  const { container, moves } = await renderBoard();

  // Backlog (0) -> In Progress (2), which publishes no status kind.
  await keyboardDrag(handleFor(container, "Backlog"), 2);
  await pointerDrag(handleFor(container, "Backlog"), "In Review");
  assert.deepEqual(moves, []);
});

test("dropping a card back on its own column does nothing", async () => {
  const { container, moves } = await renderBoard();

  await pointerDrag(handleFor(container, "Done"), "Done");
  await keyboardDrag(handleFor(container, "Triage"), 0);
  assert.deepEqual(moves, []);
});

test("a card that turns unmovable mid-drag is not moved", async () => {
  // canMoveIssue is re-read when the drop resolves, so a viewer who loses the
  // right between pickup and drop cannot sneak a move through.
  let permitted = true;
  const { container, moves } = await renderBoard({
    canMoveIssue: () => permitted,
  });
  const handle = handleFor(container, "Backlog");
  const { act, fireEvent } = await import("@testing-library/react");

  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  fireEvent.keyDown(handle, { code: "ArrowRight", key: "ArrowRight" });
  await act(async () => {});
  permitted = false;
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});

  assert.deepEqual(moves, []);
});
