import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_COMMUNITY_TASK_FILTERS,
  filterCommunityTasks,
  compareCommunityTasksForView,
} from "./communityTaskView.ts";

const AUTHOR = "a".repeat(64);
const tasks = [
  {
    id: "a",
    key: "a:a",
    title: "Zulu",
    body: "출시 준비",
    status: "todo",
    assignees: [AUTHOR],
    due: Date.UTC(2026, 8, 15) / 1_000,
    order: 2,
    createdAt: 1,
    updatedAt: 10,
  },
  {
    id: "b",
    key: "b:b",
    title: "Alpha",
    body: "",
    status: "doing",
    assignees: [],
    due: Date.UTC(2026, 8, 14) / 1_000,
    order: 1,
    createdAt: 1,
    updatedAt: 30,
  },
  {
    id: "c",
    key: "c:c",
    title: "Beta",
    body: "",
    status: "done",
    assignees: [AUTHOR],
    due: Date.UTC(2026, 8, 14) / 1_000,
    order: 3,
    createdAt: 1,
    updatedAt: 20,
  },
  {
    id: "d",
    key: "d:d",
    title: "Delta",
    body: "",
    status: "todo",
    assignees: [],
    order: 4,
    createdAt: 1,
    updatedAt: 0,
  },
];
const now = new Date(2026, 8, 15, 0, 1).getTime() / 1_000;

test("due filters use the viewer's calendar day, exclude completed overdue cards and preserve undated cards", () => {
  for (const [due, expected] of [
    ["all", ["a", "b", "c", "d"]],
    ["today", ["a"]],
    ["overdue", ["b"]],
    ["none", ["d"]],
  ]) {
    assert.deepEqual(
      filterCommunityTasks(
        tasks,
        { ...DEFAULT_COMMUNITY_TASK_FILTERS, due },
        AUTHOR,
        now,
      ).map((task) => task.id),
      expected,
    );
  }
});

test("mine is empty without an identity, supports normalized keys, and combines with Unicode search and status", () => {
  const filters = { ...DEFAULT_COMMUNITY_TASK_FILTERS, assignee: "mine" };
  assert.deepEqual(filterCommunityTasks(tasks, filters, null, now), []);
  assert.deepEqual(
    filterCommunityTasks(
      tasks,
      { ...filters, search: " 출시 ", status: "todo" },
      AUTHOR.toUpperCase(),
      now,
    ).map((task) => task.id),
    ["a"],
  );
  assert.deepEqual(
    filterCommunityTasks(
      tasks,
      { ...filters, assignee: "unassigned" },
      AUTHOR,
      now,
    ).map((task) => task.id),
    ["b", "d"],
  );
});

test("view sort is deterministic and leaves the stored order unchanged", () => {
  for (const [sort, expected] of [
    ["manual", ["b", "a", "c", "d"]],
    ["due", ["b", "c", "a", "d"]],
    ["updated", ["b", "c", "a", "d"]],
    ["title", ["b", "c", "d", "a"]],
  ]) {
    assert.deepEqual(
      [...tasks]
        .sort((a, b) => compareCommunityTasksForView(a, b, sort))
        .map((task) => task.id),
      expected,
    );
  }
  assert.deepEqual(
    tasks.map((task) => task.order),
    [2, 1, 3, 4],
  );
});
