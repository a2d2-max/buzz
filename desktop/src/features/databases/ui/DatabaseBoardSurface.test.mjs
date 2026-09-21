import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

function rect(x, y, width, height) {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    top: y,
    width,
    x,
    y,
    toJSON() {},
  };
}

before(() => {
  const { window } = dom;
  Object.assign(globalThis, {
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    document: window.document,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (callback) => {
      const handle = setTimeout(callback, 0);
      handle.unref?.();
      return handle;
    },
    self: window,
    window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  window.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  globalThis.matchMedia = window.matchMedia;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        [
          "Element",
          "Node",
          "Event",
          "MouseEvent",
          "KeyboardEvent",
          "PointerEvent",
          "EventTarget",
        ].includes(key))
    ) {
      if (window[key] !== undefined) globalThis[key] = window[key];
    }
  }
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const source =
      this.dataset.testid === "database-board-overlay"
        ? window.document.querySelector('[data-drag-state="dragging"]')
        : this;
    const owner = source?.closest("[data-group-key]");
    const index = [
      ...window.document.querySelectorAll("[data-group-key]"),
    ].indexOf(owner);
    if (index < 0) return rect(0, 0, 0, 0);
    const left = index * 268;
    return source?.dataset.testid === "database-board-card"
      ? rect(left + 5, 50, 250, 40)
      : rect(left, 0, 250, 400);
  };
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
after(() => dom.window.close());

const property = {
  id: "status",
  name: "Status",
  type: "status",
  options: {
    choices: [
      { id: "todo", name: "To do", group: "todo" },
      { id: "done", name: "Done", group: "done" },
    ],
  },
};
const row = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  databaseId: "11111111-2222-4333-8444-555555555555",
  values: { title: "Launch", status: "todo", notes: "keep" },
  docPageId: null,
  createdBy: "a".repeat(64),
  createdAt: 1,
  updatedAt: 1,
  author: "b".repeat(64),
  eventId: "1".repeat(64),
  eventCreatedAt: 1,
  eventKind: 30625,
  deleted: false,
};

function groups() {
  const resolved = { row, values: new Map(Object.entries(row.values)) };
  return [
    {
      key: "choice:todo",
      label: "To do",
      value: "todo",
      rows: [resolved],
      empty: false,
    },
    {
      key: "choice:done",
      label: "Done",
      value: "done",
      rows: [],
      empty: false,
    },
    { key: "empty", label: "Empty", value: null, rows: [], empty: true },
  ];
}

async function renderBoard(overrides = {}) {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { DatabaseBoardSurface } = await import("./DatabaseBoardSurface.tsx");
  const calls = [];
  const result = render(
    React.createElement(DatabaseBoardSurface, {
      groups: groups(),
      groupProperty: property,
      titleProperty: { id: "title", name: "Name", type: "title" },
      onSaveRowValues: async (rowId, values, baseEventId) => {
        calls.push({ rowId, values, baseEventId });
        return { ...row, values, eventId: "2".repeat(64) };
      },
      ...overrides,
    }),
  );
  return { ...result, calls };
}

async function keyboardDrag(handle, steps, cancel = false) {
  const { act, fireEvent } = await import("@testing-library/react");
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let index = 0; index < steps; index += 1) {
    fireEvent.keyDown(handle, { code: "ArrowRight", key: "ArrowRight" });
    await act(async () => {});
  }
  fireEvent.keyDown(handle, {
    code: cancel ? "Escape" : "Space",
    key: cancel ? "Escape" : " ",
  });
  await act(async () => {});
}

async function pointerDrag(handle, targetIndex) {
  const { act, fireEvent } = await import("@testing-library/react");
  const start = handle.getBoundingClientRect();
  const pointer = { isPrimary: true, pointerId: 1 };
  fireEvent.pointerDown(handle, {
    ...pointer,
    button: 0,
    clientX: start.left,
    clientY: 50,
  });
  fireEvent.pointerMove(document, {
    ...pointer,
    clientX: start.left + 20,
    clientY: 50,
  });
  await act(async () => {});
  fireEvent.pointerMove(document, {
    ...pointer,
    clientX: targetIndex * 268 + 125,
    clientY: 200,
  });
  await act(async () => {});
  fireEvent.pointerUp(document, {
    ...pointer,
    clientX: targetIndex * 268 + 125,
    clientY: 200,
  });
  await act(async () => {});
}

test("keyboard, pointer, and cancel paths publish exactly one full row only for accepted moves", async () => {
  const board = await renderBoard();
  const handle = board.getByRole("button", { name: "Move Launch" });
  await keyboardDrag(handle, 1);
  assert.deepEqual(board.calls[0], {
    rowId: row.id,
    values: { title: "Launch", status: "done", notes: "keep" },
    baseEventId: row.eventId,
  });
  await pointerDrag(handle, 2);
  assert.deepEqual(board.calls[1].values, {
    title: "Launch",
    status: null,
    notes: "keep",
  });
  assert.match(document.body.textContent, /Moved Launch to Empty/i);
  await keyboardDrag(handle, 1, true);
  assert.equal(board.calls.length, 2);
});

test("board renders explicit Empty and human labels without duplicate native roles", async () => {
  const board = await renderBoard();
  assert.equal(board.getAllByTestId("database-board-column").length, 3);
  assert.ok(board.getByRole("region", { name: "Empty Status" }));
  const handle = board.getByRole("button", { name: "Move Launch" });
  assert.equal(handle.getAttribute("aria-roledescription"), "draggable");
});

test("person card identity keeps same-column no-op distinct from a real cross-column move", async () => {
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  const personRow = { ...row, values: { ...row.values, people: [alice, bob] } };
  const resolved = {
    row: personRow,
    values: new Map(Object.entries(personRow.values)),
  };
  const board = await renderBoard({
    groupProperty: { id: "people", name: "People", type: "person" },
    groups: [
      {
        key: `string:${alice}`,
        label: "Alice",
        value: alice,
        rows: [resolved],
        empty: false,
      },
      {
        key: `string:${bob}`,
        label: "Bob",
        value: bob,
        rows: [resolved],
        empty: false,
      },
      { key: "empty", label: "Empty", value: null, rows: [], empty: true },
    ],
  });
  const aliceHandle = board.container.querySelector(
    `[data-group-key="string:${alice}"] [aria-label="Move Launch"]`,
  );
  await keyboardDrag(aliceHandle, 0);
  assert.equal(board.calls.length, 0);
  await keyboardDrag(aliceHandle, 1);
  assert.equal(board.calls.length, 1);
  assert.deepEqual(board.calls[0].values.people, [bob]);
});

test("board announcements name the active row and report a same-column no-op honestly", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const board = await renderBoard();
  const handle = board.getByRole("button", { name: "Move Launch" });
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  assert.match(document.body.textContent, /Launch is over To do/i);
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  assert.match(document.body.textContent, /Launch was left where it was/i);
  assert.doesNotMatch(document.body.textContent, /Moved Launch to To do/i);
  assert.equal(board.calls.length, 0);

  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {});
  fireEvent.keyDown(handle, { code: "Escape", key: "Escape" });
  await act(async () => {});
  assert.match(
    document.body.textContent,
    /Cancelled\. Launch was left where it was/i,
  );
});
