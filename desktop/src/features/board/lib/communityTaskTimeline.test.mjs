import assert from "node:assert/strict";
import { test } from "node:test";
import {
  timelineWeekStart,
  timelineDays,
  tasksOnTimelineDay,
} from "./communityTaskTimeline.ts";
test("deadline weeks cross DST and year boundaries as calendar days", () => {
  const start = timelineWeekStart(new Date(2026, 0, 1).getTime() / 1000);
  assert.equal(new Date(start * 1000).toISOString().slice(0, 10), "2025-12-29");
  assert.deepEqual(
    timelineDays(start).map((d) => new Date(d * 1000).getUTCDay()),
    [1, 2, 3, 4, 5, 6, 0],
  );
  const dst = Date.UTC(2026, 2, 2) / 1000;
  assert.equal(timelineDays(dst)[6] - dst, 6 * 86400);
  const tasks = [
    { id: "late", due: dst + 86399 },
    { id: "next", due: dst + 86400 },
    { id: "none" },
  ];
  assert.deepEqual(
    tasksOnTimelineDay(tasks, dst).map((t) => t.id),
    ["late"],
  );
});
