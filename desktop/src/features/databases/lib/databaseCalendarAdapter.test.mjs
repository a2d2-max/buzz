import assert from "node:assert/strict";
import test from "node:test";

const ROW = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  databaseId: "11111111-2222-4333-8444-555555555555",
  values: { title: "Launch" },
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

function localDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

test("date-only single days use a local exclusive library end and round trip without an end", async () => {
  const adapter = await import("./databaseCalendarAdapter.ts");
  const source = { start: "2026-09-09", includeTime: false };
  const event = adapter.databaseRowToCalendarEvent(ROW, "Launch", source);
  assert.equal(event.allDay, true);
  assert.equal(localDate(event.start), "2026-09-09");
  assert.equal(localDate(event.end), "2026-09-10");
  assert.deepEqual(
    adapter.calendarRangeToDatabaseDateValue({
      start: event.start,
      end: event.end,
      allDay: true,
    }),
    source,
  );
});

test("inclusive all-day ranges round trip across month and DST-adjacent calendar days", async () => {
  const adapter = await import("./databaseCalendarAdapter.ts");
  for (const source of [
    { start: "2026-03-28", end: "2026-04-02", includeTime: false },
    { start: "2026-10-31", end: "2026-11-02", includeTime: false },
  ]) {
    const event = adapter.databaseRowToCalendarEvent(ROW, "Launch", source);
    assert.equal(
      localDate(event.end),
      adapter.addDatabaseCalendarDay(source.end),
    );
    assert.deepEqual(
      adapter.calendarRangeToDatabaseDateValue({
        start: event.start,
        end: event.end,
        allDay: true,
      }),
      source,
    );
  }
});

test("timed offsets render as instants while retaining their exact stored source", async () => {
  const adapter = await import("./databaseCalendarAdapter.ts");
  const source = {
    start: "2026-09-09T09:30:00+09:00",
    end: "2026-09-09T10:45:00+09:00",
    includeTime: true,
  };
  const event = adapter.databaseRowToCalendarEvent(ROW, "Launch", source);
  assert.equal(event.allDay, false);
  assert.equal(event.start.toISOString(), "2026-09-09T00:30:00.000Z");
  assert.equal(event.end.toISOString(), "2026-09-09T01:45:00.000Z");
  assert.equal(event.source.date, source);
  assert.deepEqual(
    adapter.calendarRangeToDatabaseDateValue({
      start: event.start,
      end: event.end,
      allDay: false,
    }),
    {
      start: event.start.toISOString(),
      end: event.end.toISOString(),
      includeTime: true,
    },
  );
});

test("invalid dates are recoverable omissions instead of malformed calendar events", async () => {
  const { databaseRowToCalendarEvent } = await import(
    "./databaseCalendarAdapter.ts"
  );
  assert.equal(
    databaseRowToCalendarEvent(ROW, "Launch", {
      start: "2026-02-30",
      includeTime: false,
    }),
    null,
  );
  assert.equal(
    databaseRowToCalendarEvent(ROW, "Launch", {
      start: "tomorrow",
      includeTime: true,
    }),
    null,
  );
  assert.equal(
    databaseRowToCalendarEvent(ROW, "Launch", {
      start: "2026-02-30T09:00:00Z",
      includeTime: true,
    }),
    null,
  );
});
