import assert from "node:assert/strict";
import test from "node:test";

import {
  ISSUE_BOARD_COLUMN_ORDER,
  isIssueBoardDropStatus,
  issueBoardDropTarget,
  resolveIssueBoardDrop,
} from "./issueBoardColumns.ts";
import { ISSUE_STATUS_ORDER } from "./issueStatusDisplay.ts";

// Every board column, left to right, with the status kind and protocol word a
// drop into it publishes. This is the full input space of
// `issueBoardDropTarget`, so a new status that forgets its kind (or wrongly
// gains one) fails here.
const COLUMNS = [
  ["Backlog", 1630, "open"],
  ["Triage", 1633, "draft"],
  ["In Progress", null, null],
  ["In Review", null, null],
  ["Done", 1631, "resolved"],
  ["Closed", 1632, "closed"],
];

test("the board reads left to right as a workflow", () => {
  assert.deepEqual(
    ISSUE_BOARD_COLUMN_ORDER,
    COLUMNS.map(([status]) => status),
  );
  // The grouped list keeps its own order; the two must not be conflated.
  assert.deepEqual(ISSUE_STATUS_ORDER, [
    "In Review",
    "In Progress",
    "Triage",
    "Backlog",
    "Done",
    "Closed",
  ]);
  assert.deepEqual(
    [...ISSUE_BOARD_COLUMN_ORDER].sort(),
    [...ISSUE_STATUS_ORDER].sort(),
  );
});

test("board columns map onto their NIP-34 status kind and protocol word", () => {
  for (const [status, kind, word] of COLUMNS) {
    const target = issueBoardDropTarget(status);
    assert.deepEqual(target, kind === null ? null : { kind, word }, status);
    assert.equal(isIssueBoardDropStatus(status), kind !== null, status);
  }
});

test("label-derived columns never publish a status event", () => {
  for (const status of ["In Progress", "In Review"]) {
    assert.equal(issueBoardDropTarget(status), null);
  }
  assert.equal(issueBoardDropTarget("Nonexistent"), null);
});

test("resolveIssueBoardDrop only accepts a real move by a permitted viewer", () => {
  const cases = [
    // [currentStatus, overStatus, permitted, expected]
    ["Backlog", "Done", true, "Done"],
    ["In Progress", "Closed", true, "Closed"],
    ["Done", "Backlog", true, "Backlog"],
    // Same column is a no-op.
    ["Backlog", "Backlog", true, null],
    ["Done", "Done", true, null],
    // Label-only columns are not drop targets.
    ["Backlog", "In Progress", true, null],
    ["Done", "In Review", true, null],
    // Dropped outside any column.
    ["Backlog", undefined, true, null],
    // Viewer may not move this card.
    ["Backlog", "Done", false, null],
    ["Backlog", "In Progress", false, null],
  ];
  for (const [currentStatus, overStatus, permitted, expected] of cases) {
    assert.equal(
      resolveIssueBoardDrop({ currentStatus, overStatus, permitted }),
      expected,
      `${currentStatus} -> ${overStatus} (permitted=${permitted})`,
    );
  }
});
