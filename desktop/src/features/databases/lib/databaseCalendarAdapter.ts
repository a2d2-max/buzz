import type { DatabaseRow } from "./databaseRowCodec";
import type { DatabaseDateValue } from "./databaseValue";
import {
  isDatabaseDateOnly,
  isDatabaseTimedInstant,
} from "./databaseDateValue";

export type DatabaseCalendarEvent = {
  rowId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  source: { row: DatabaseRow; date: DatabaseDateValue };
};

function parseDateOnly(value: string): Date | null {
  if (!isDatabaseDateOnly(value)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date;
}

function formatDateOnly(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

function shiftCalendarDay(value: Date, amount: number): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + amount,
  );
}

/** Adds one local calendar day without assuming that every day is 24 hours. */
export function addDatabaseCalendarDay(value: string): string {
  const date = parseDateOnly(value);
  if (!date) throw new Error("Invalid date-only calendar value.");
  return formatDateOnly(shiftCalendarDay(date, 1));
}

function parseTimed(value: string): Date | null {
  if (!isDatabaseTimedInstant(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Converts one validated stored date into react-big-calendar semantics. */
export function databaseRowToCalendarEvent(
  row: DatabaseRow,
  title: string,
  date: DatabaseDateValue,
): DatabaseCalendarEvent | null {
  if (date.includeTime) {
    const start = parseTimed(date.start);
    const end = date.end ? parseTimed(date.end) : start;
    if (!start || !end || end < start) return null;
    return {
      rowId: row.id,
      title: title.trim() || "Untitled",
      start,
      end,
      allDay: false,
      source: { row, date },
    };
  }
  const start = parseDateOnly(date.start);
  const storedEnd = date.end ? parseDateOnly(date.end) : start;
  if (!start || !storedEnd || storedEnd < start) return null;
  return {
    rowId: row.id,
    title: title.trim() || "Untitled",
    start,
    end: shiftCalendarDay(storedEnd, 1),
    allDay: true,
    source: { row, date },
  };
}

/** Converts a calendar selection to the database's inclusive stored range. */
export function calendarRangeToDatabaseDateValue({
  start,
  end,
  allDay,
}: {
  start: Date;
  end?: Date;
  allDay: boolean;
}): DatabaseDateValue {
  if (
    !Number.isFinite(start.getTime()) ||
    (end && !Number.isFinite(end.getTime()))
  ) {
    throw new Error("Calendar range dates must be valid.");
  }
  if (!allDay) {
    return {
      start: start.toISOString(),
      ...(end && end.getTime() !== start.getTime()
        ? { end: end.toISOString() }
        : {}),
      includeTime: true,
    };
  }
  const inclusiveEnd = shiftCalendarDay(end ?? shiftCalendarDay(start, 1), -1);
  const startText = formatDateOnly(start);
  const endText = formatDateOnly(inclusiveEnd);
  return {
    start: startText,
    ...(endText !== startText ? { end: endText } : {}),
    includeTime: false,
  };
}
