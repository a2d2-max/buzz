import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import {
  BOARD_ORDER,
  columnOf,
  handleFor,
  installBoardTestDom,
  keyboardDrag,
  makeTask,
  pointerDrag,
} from "./communityTaskTestDom.mjs";

let dom;

before(() => {
  dom = installBoardTestDom();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const TASKS = [
  makeTask({ id: "todo-1", status: "todo", order: 2 }),
  makeTask({ id: "todo-0", status: "todo", order: 1 }),
  makeTask({ id: "doing-1", status: "doing" }),
  makeTask({ id: "done-1", status: "done" }),
];

async function renderBoard(overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { CommunityTasksBoard } = await import("./CommunityTasksBoard.tsx");
  const moves = [];
  const opened = [];
  const result = render(
    createElement(CommunityTasksBoard, {
      canMoveTask: () => true,
      onMoveTask: (task, status) => moves.push([task.id, status]),
      onOpenTask: (task) => opened.push(task.id),
      tasks: TASKS,
      ...overrides,
    }),
  );
  return { ...result, moves, opened };
}

test("renders To Do, Doing, Done with their cards in column order", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard();

  const columns = screen.getAllByTestId("community-task-column");
  assert.deepEqual(
    columns.map((column) => column.getAttribute("data-status")),
    BOARD_ORDER,
  );
  assert.deepEqual(
    columns.map((column) => column.querySelector("h3").textContent),
    ["To Do2", "Doing1", "Done1"],
  );
  const todoCards = [
    ...columns[0].querySelectorAll("[data-testid='community-task-card']"),
  ].map((card) => card.getAttribute("data-task-id"));
  assert.deepEqual(todoCards, ["todo-0", "todo-1"], "sorted by order");
});

test("opens the task the card stands for", async () => {
  const { fireEvent } = await import("@testing-library/react");
  const { container, opened } = await renderBoard();

  fireEvent.click(
    container.querySelector(
      "[data-task-id='doing-1'] [data-testid='community-task-card-open']",
    ),
  );
  assert.deepEqual(opened, ["doing-1"]);
});

test("a viewer who may not move tasks gets no drag handles", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard({ canMoveTask: () => false });

  assert.equal(screen.queryAllByTestId("community-task-drag-handle").length, 0);
  assert.equal(screen.getAllByTestId("community-task-card").length, 4);
});

test("a permitted viewer gets a labelled drag handle per card", async () => {
  const { screen } = await import("@testing-library/react");
  await renderBoard();

  const handles = screen.getAllByTestId("community-task-drag-handle");
  assert.equal(handles.length, 4);
  assert.equal(handles[0].getAttribute("aria-label"), "Move Task todo-0");
  // The native button already carries the role; dnd-kit must not re-add it.
  assert.equal(handles[0].getAttribute("aria-roledescription"), "draggable");
});

test("a keyboard drag drops the card into the next column", async () => {
  const { container, moves } = await renderBoard();

  await keyboardDrag(handleFor(container, "todo"), 1);
  assert.deepEqual(moves, [["todo-0", "doing"]]);
});

test("a keyboard drag can cross a column to Done", async () => {
  const { container, moves } = await renderBoard();

  await keyboardDrag(handleFor(container, "todo"), 2);
  assert.deepEqual(moves, [["todo-0", "done"]]);
});

test("a pointer drag drops the card into the column under the pointer", async () => {
  const { container, moves } = await renderBoard();

  await pointerDrag(handleFor(container, "done"), "todo");
  assert.deepEqual(moves, [["done-1", "todo"]]);
});

test("dropping a card back on its own column does nothing", async () => {
  const { container, moves } = await renderBoard();

  await pointerDrag(handleFor(container, "doing"), "doing");
  await keyboardDrag(handleFor(container, "todo"), 0);
  assert.deepEqual(moves, []);
});

test("a card that turns unmovable mid-drag is not moved", async () => {
  let permitted = true;
  const { container, moves } = await renderBoard({
    canMoveTask: () => permitted,
  });
  const handle = handleFor(container, "todo");
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
  assert.equal(columnOf(container, "todo-0"), "todo");
});

test("a due date shows on the card and only an unfinished card reads overdue", async () => {
  const { container } = await renderBoard({
    tasks: [
      makeTask({ id: "late", status: "doing", due: 1 }),
      makeTask({ id: "finished", status: "done", due: 1 }),
      makeTask({ id: "undated", status: "todo" }),
    ],
  });
  const late = container.querySelector(
    "[data-task-id='late'] [data-testid='community-task-due']",
  );
  const finished = container.querySelector(
    "[data-task-id='finished'] [data-testid='community-task-due']",
  );
  assert.ok(late);
  assert.ok(finished);
  assert.equal(late.hasAttribute("data-overdue"), true);
  assert.equal(finished.hasAttribute("data-overdue"), false);
  assert.equal(
    container.querySelector(
      "[data-task-id='undated'] [data-testid='community-task-due']",
    ),
    null,
  );
});
