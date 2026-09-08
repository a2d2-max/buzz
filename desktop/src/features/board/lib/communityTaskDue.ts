/**
 * A due date is a calendar day, not an instant: "Sep 12" must read as Sep 12
 * for a viewer in any time zone. The wire value is unix seconds at **UTC
 * midnight** of that day; every read here goes through the UTC getters so a
 * viewer west of Greenwich does not see the previous day.
 */

const SAME_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const OTHER_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function calendarParts(due: number): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(due * 1_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
}

/** `<input type="date">` value for a due stamp: the calendar day it names. */
export function dueToDateInputValue(due: number | undefined): string {
  if (due === undefined) return "";
  const { year, month, day } = calendarParts(due);
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/**
 * The due stamp for an `<input type="date">` value: UTC midnight of that
 * day, in unix seconds. Empty or malformed input means "no due date".
 */
export function dateInputValueToDue(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const stamp = Date.UTC(year, month, day);
  if (Number.isNaN(stamp)) return undefined;
  // Reject Feb 30 and friends, which Date silently rolls forward.
  const date = new Date(stamp);
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return undefined;
  }
  return Math.floor(stamp / 1_000);
}

/**
 * Past the end of the due day in the viewer's own zone. Whether that matters
 * is the caller's call — a Done card is never overdue.
 */
export function isCommunityTaskOverdue(
  due: number,
  nowSeconds = Date.now() / 1_000,
): boolean {
  const { year, month, day } = calendarParts(due);
  const endOfDueDay = new Date(year, month, day, 23, 59, 59, 999);
  return nowSeconds > endOfDueDay.getTime() / 1_000;
}

/** "Sep 12", or "Sep 12, 2027" once the year differs from today's. */
export function formatCommunityTaskDue(
  due: number,
  nowSeconds = Date.now() / 1_000,
): string {
  const date = new Date(due * 1_000);
  const now = new Date(nowSeconds * 1_000);
  return date.getUTCFullYear() === now.getFullYear()
    ? SAME_YEAR_FORMATTER.format(date)
    : OTHER_YEAR_FORMATTER.format(date);
}
