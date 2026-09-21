import { enUS } from "date-fns/locale";
import { format, getDay, parse, startOfWeek } from "date-fns";
import * as React from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import "react-big-calendar/lib/css/react-big-calendar.css";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  databaseRowToCalendarEvent,
  type DatabaseCalendarEvent,
} from "../lib/databaseCalendarAdapter";
import { databaseCellPresentation } from "../lib/databaseCellModel";
import { databaseComparableDate } from "../lib/databaseDateValue";
import type { DatabaseRow } from "../lib/databaseRowCodec";
import type { DatabaseProperty } from "../lib/databaseSchemaCodec";
import type {
  DatabaseCellValue,
  DatabaseDateValue,
} from "../lib/databaseValue";
import type { ResolvedDatabaseRow } from "../lib/databaseViewEngine";

const localizer = dateFnsLocalizer({
  format,
  getDay,
  locales: { "en-US": enUS },
  parse,
  startOfWeek,
});

function asDateValue(value: unknown): DatabaseDateValue | null {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "start" in value &&
    typeof value.start === "string" &&
    "includeTime" in value &&
    typeof value.includeTime === "boolean"
    ? (value as DatabaseDateValue)
    : null;
}

function titleOf(resolved: ResolvedDatabaseRow, property: DatabaseProperty) {
  const value = resolved.values.get(property.id);
  return typeof value === "string"
    ? value.trim() || "Untitled"
    : databaseCellPresentation(property, resolved.row).text.trim() ||
        "Untitled";
}

function dateEditorValue(value: string | undefined, timed: boolean) {
  if (!value) return "";
  if (!timed) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset();
  return new Date(parsed.getTime() - offset * 60_000)
    .toISOString()
    .slice(0, 16);
}

function MissingDateEditor({
  dateProperty,
  onSaveRowValues,
  resolved,
  title,
}: {
  dateProperty: DatabaseProperty;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  resolved: ResolvedDatabaseRow;
  title: string;
}) {
  const source = asDateValue(resolved.values.get(dateProperty.id));
  const [editing, setEditing] = React.useState(false);
  const [includeTime, setIncludeTime] = React.useState(
    source?.includeTime ?? false,
  );
  const [start, setStart] = React.useState(() =>
    dateEditorValue(source?.start, source?.includeTime ?? false),
  );
  const [end, setEnd] = React.useState(() =>
    dateEditorValue(source?.end, source?.includeTime ?? false),
  );
  const [failure, setFailure] = React.useState<{
    date: DatabaseDateValue;
    message: string;
  } | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );
  const [saving, setSaving] = React.useState(false);
  const startInputId = React.useId();
  const endInputId = React.useId();

  const persist = async (date: DatabaseDateValue) => {
    setSaving(true);
    setFailure(null);
    setValidationError(null);
    try {
      await onSaveRowValues(
        resolved.row.id,
        { ...resolved.row.values, [dateProperty.id]: date },
        resolved.row.eventId,
      );
      setEditing(false);
    } catch (error) {
      setFailure({
        date,
        message:
          error instanceof Error ? error.message : "Couldn't save this date.",
      });
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    if (!start) return;
    const normalize = (value: string) => {
      if (!includeTime) return value;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    };
    const normalizedStart = normalize(start);
    const normalizedEnd = end ? normalize(end) : undefined;
    const startValue = normalizedStart
      ? databaseComparableDate(normalizedStart, includeTime)
      : null;
    const endValue = normalizedEnd
      ? databaseComparableDate(normalizedEnd, includeTime)
      : null;
    if (
      normalizedStart === null ||
      startValue === null ||
      (end && endValue === null)
    ) {
      setValidationError("Enter a valid date range.");
      return;
    }
    const endBeforeStart =
      typeof startValue === "number"
        ? typeof endValue === "number" && endValue < startValue
        : typeof endValue === "string" && endValue < startValue;
    if (endBeforeStart) {
      setValidationError("The end date cannot be before the start date.");
      return;
    }
    const date: DatabaseDateValue = {
      start: normalizedStart,
      ...(normalizedEnd ? { end: normalizedEnd } : {}),
      includeTime,
    };
    void persist(date);
  };
  return (
    <div className="rounded-lg border border-border/60 bg-background p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">{title}</span>
        <Button
          aria-label={`Set date for ${title}`}
          onClick={() => setEditing(true)}
          size="xs"
          type="button"
          variant="outline"
        >
          Set date
        </Button>
      </div>
      {editing ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1" htmlFor={startInputId}>
            <span>Start</span>
            <Input
              aria-label={`Date for ${title}`}
              id={startInputId}
              onChange={(event) => {
                setStart(event.target.value);
                setFailure(null);
                setValidationError(null);
              }}
              type={includeTime ? "datetime-local" : "date"}
              value={start}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={endInputId}>
            <span>End</span>
            <Input
              aria-label={`End date for ${title}`}
              id={endInputId}
              onChange={(event) => {
                setEnd(event.target.value);
                setFailure(null);
                setValidationError(null);
              }}
              type={includeTime ? "datetime-local" : "date"}
              value={end}
            />
          </label>
          <label className="flex h-9 items-center gap-2">
            <input
              checked={includeTime}
              onChange={(event) => {
                setIncludeTime(event.target.checked);
                setFailure(null);
                setValidationError(null);
              }}
              type="checkbox"
            />{" "}
            Include time
          </label>
          <Button
            aria-label={`Save date for ${title}`}
            disabled={saving || !start}
            onClick={save}
            size="sm"
            type="button"
          >
            Save
          </Button>
          <Button
            onClick={() => setEditing(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {validationError ? (
        <div className="mt-2 text-destructive" role="alert">
          {validationError}
        </div>
      ) : null}
      {failure ? (
        <div
          className="mt-2 flex items-center gap-2 text-destructive"
          role="alert"
        >
          <span>{failure.message}</span>
          <Button
            aria-label={`Retry date for ${title}`}
            disabled={saving}
            onClick={() => void persist(failure.date)}
            size="xs"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Real react-big-calendar renderer with a recovery tray for missing dates. */
export function DatabaseCalendarSurface({
  dateProperty,
  rows,
  titleProperty,
  onSaveRowValues,
}: {
  dateProperty: DatabaseProperty;
  rows: ResolvedDatabaseRow[];
  titleProperty: DatabaseProperty;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
}) {
  const events: DatabaseCalendarEvent[] = [];
  const needsDate: ResolvedDatabaseRow[] = [];
  for (const resolved of rows) {
    const date = asDateValue(resolved.values.get(dateProperty.id));
    const event = date
      ? databaseRowToCalendarEvent(
          resolved.row,
          titleOf(resolved, titleProperty),
          date,
        )
      : null;
    if (event) events.push(event);
    else needsDate.push(resolved);
  }
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto p-4"
      data-testid="database-calendar-surface"
    >
      <div className="min-h-[32rem]" style={{ height: "34rem" }}>
        <Calendar<DatabaseCalendarEvent>
          allDayAccessor="allDay"
          defaultDate={events[0]?.start ?? new Date()}
          endAccessor="end"
          events={events}
          localizer={localizer}
          startAccessor="start"
          titleAccessor="title"
          views={["month", "week", "day", "agenda"]}
        />
      </div>
      {needsDate.length ? (
        <section
          aria-labelledby="database-needs-date"
          className="mt-4 flex flex-col gap-2"
        >
          <h2 className="text-xs font-semibold" id="database-needs-date">
            Needs date
          </h2>
          {needsDate.map((resolved) => (
            <MissingDateEditor
              dateProperty={dateProperty}
              key={resolved.row.id}
              onSaveRowValues={onSaveRowValues}
              resolved={resolved}
              title={titleOf(resolved, titleProperty)}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
