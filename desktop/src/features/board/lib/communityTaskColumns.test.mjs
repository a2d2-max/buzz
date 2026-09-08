import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMUNITY_TASK_COLUMN_ORDER,
  COMMUNITY_TASK_STATUS_LABELS,
  communityTasksByStatus,
  compareCommunityTasksInColumn,
  resolveCommunityTaskDrop,
} from "./communityTaskColumns.ts";

test("the board reads To Do, Doing, Done left to right", () => {
  assert.deepEqual(COMMUNITY_TASK_COLUMN_ORDER, ["todo", "doing", "done"]);
  assert.deepEqual(
    COMMUNITY_TASK_COLUMN_ORDER.map(
      (status) => COMMUNITY_TASK_STATUS_LABELS[status],
    ),
    ["To Do", "Doing", "Done"],
  );
});

test("resolveCommunityTaskDrop only accepts a real move by a permitted viewer", () => {
  const cases = [
    // [currentStatus, overStatus, permitted, expected]
    ["todo", "doing", true, "doing"],
    ["doing", "done", true, "done"],
    ["done", "todo", true, "todo"],
    ["todo", "todo", true, null],
    ["todo", undefined, true, null],
    ["todo", "done", false, null],
  ];
  for (const [currentStatus, overStatus, permitted, expected] of cases) {
    assert.equal(
      resolveCommunityTaskDrop({ currentStatus, overStatus, permitted }),
      expected,
      `${currentStatus} -> ${overStatus} (permitted=${permitted})`,
    );
  }
});

test("cards sort by order, then age, then id", () => {
  const cards = [
    { id: "c", order: 2, createdAt: 1 },
    { id: "b", order: 1, createdAt: 9 },
    { id: "a", order: 1, createdAt: 9 },
    { id: "d", order: 1, createdAt: 5 },
  ];
  assert.deepEqual(
    [...cards].sort(compareCommunityTasksInColumn).map((card) => card.id),
    ["d", "a", "b", "c"],
  );
});

test("communityTasksByStatus buckets and sorts every column", () => {
  const columns = communityTasksByStatus([
    { id: "x", status: "done", order: 3, createdAt: 1 },
    { id: "y", status: "todo", order: 2, createdAt: 1 },
    { id: "z", status: "todo", order: 1, createdAt: 1 },
  ]);
  assert.deepEqual(
    columns.todo.map((task) => task.id),
    ["z", "y"],
  );
  assert.deepEqual(columns.doing, []);
  assert.deepEqual(
    columns.done.map((task) => task.id),
    ["x"],
  );
});
