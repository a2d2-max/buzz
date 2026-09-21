import type { DatabaseDateValue } from "./databaseValue";

/** Strictly validates a real Gregorian YYYY-MM-DD date. */
export function isDatabaseDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Strictly validates an offset-bearing ISO instant without date normalization. */
export function isDatabaseTimedInstant(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !isDatabaseDateOnly(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  const offsetHour = Number(match[7] ?? "0");
  const offsetMinute = Number(match[8] ?? "0");
  return (
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** Validates both endpoints against a date cell's declared time mode. */
export function databaseDateValueMatches(value: DatabaseDateValue): boolean {
  const endpoints = value.end ? [value.start, value.end] : [value.start];
  return value.includeTime
    ? endpoints.every(isDatabaseTimedInstant)
    : endpoints.every(isDatabaseDateOnly);
}

/** Returns the comparable calendar string or instant for a strict endpoint. */
export function databaseComparableDate(
  value: string,
  includeTime: boolean,
): number | string | null {
  if (includeTime)
    return isDatabaseTimedInstant(value) ? Date.parse(value) : null;
  return isDatabaseDateOnly(value) ? value : null;
}
