import assert from "node:assert/strict";
import test from "node:test";

import {
  dateInputValueToDue,
  dueToDateInputValue,
  formatCommunityTaskDue,
  isCommunityTaskOverdue,
} from "./communityTaskDue.ts";

test("a date input value is stored as UTC midnight and reads back as the same day", () => {
  const due = dateInputValueToDue("2026-09-12");
  assert.equal(due, Date.UTC(2026, 8, 12) / 1_000);
  assert.equal(dueToDateInputValue(due), "2026-09-12");
  assert.equal(dueToDateInputValue(undefined), "");
});

test("the calendar day is read in UTC, so no viewer's zone shifts it", () => {
  // 2026-09-12T00:00Z is still Sep 11 in every zone west of Greenwich; the
  // label must not depend on where the viewer sits.
  const due = Date.UTC(2026, 8, 12) / 1_000;
  assert.equal(dueToDateInputValue(due), "2026-09-12");
  assert.match(formatCommunityTaskDue(due, Date.UTC(2026, 0, 1) / 1_000), /12/);
});

test("malformed or impossible dates mean no due date", () => {
  for (const value of [
    "",
    "  ",
    "12/09/2026",
    "2026-13-01",
    "2026-02-30",
    "abc",
  ]) {
    assert.equal(dateInputValueToDue(value), undefined, JSON.stringify(value));
  }
});

test("overdue starts after the end of the due day in the viewer's zone", () => {
  const due = dateInputValueToDue("2026-09-12");
  const lateThatDay = new Date(2026, 8, 12, 23, 0).getTime() / 1_000;
  const nextMorning = new Date(2026, 8, 13, 0, 5).getTime() / 1_000;
  assert.equal(isCommunityTaskOverdue(due, lateThatDay), false);
  assert.equal(isCommunityTaskOverdue(due, nextMorning), true);
});

test("the due label drops the year until it differs from today's", () => {
  const due = dateInputValueToDue("2026-09-12");
  const sameYear = new Date(2026, 0, 1).getTime() / 1_000;
  const otherYear = new Date(2027, 0, 1).getTime() / 1_000;
  assert.equal(formatCommunityTaskDue(due, sameYear).includes("2026"), false);
  assert.equal(formatCommunityTaskDue(due, otherYear).includes("2026"), true);
});
