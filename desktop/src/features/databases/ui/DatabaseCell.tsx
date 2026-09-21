// biome-ignore-all lint/a11y/useSemanticElements: react-window requires virtual ARIA grid cells to use positioned divs.
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  databaseCellRecoveryType,
  databaseCellPresentation,
  parseDatabaseCellDraft,
} from "../lib/databaseCellModel";
import {
  databaseComputedValueText,
  isDatabaseComputedError,
} from "../lib/databaseComputedValue";
import {
  databasePropertyLabel,
  databasePropertyRegistration,
} from "../lib/databasePropertyRegistry";
import type { DatabaseRow } from "../lib/databaseRowCodec";
import type {
  DatabaseProperty,
  DatabasePropertyType,
} from "../lib/databaseSchemaCodec";
import type {
  DatabaseCellValue,
  DatabaseDateValue,
} from "../lib/databaseValue";
import type { DatabaseResolvedValue } from "../lib/databaseViewEngine";
import {
  DatabaseRelationCell,
  type DatabaseRelationCellContext,
} from "./DatabaseRelationCell";

type DatabaseCellProps = {
  knownPubkeys: string[];
  property: DatabaseProperty;
  row: DatabaseRow;
  width: number;
  relationContext?: DatabaseRelationCellContext;
  resolvedValue?: DatabaseResolvedValue;
  onRestoreType: (type: DatabasePropertyType) => Promise<void>;
  onSave: (
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
};

type FailedSave = {
  values: Record<string, DatabaseCellValue>;
  baseEventId: string;
};

function CellSaveFailure({
  error,
  failure,
  name,
  saving,
  onRetry,
}: {
  error: string | null;
  failure: FailedSave | null;
  name: string;
  saving: boolean;
  onRetry: (failure: FailedSave) => void;
}) {
  if (!error && (!failure || saving)) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-2xs text-destructive"
      role="alert"
    >
      {error ? (
        <span className="min-w-0 truncate" title={error}>
          {error}
        </span>
      ) : null}
      {failure && !saving ? (
        <Button
          aria-label={`Retry ${name}`}
          onClick={() => onRetry(failure)}
          size="xs"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}

function editableDraft(value: DatabaseCellValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "string" ? entry : (entry.name ?? entry.url),
      )
      .join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function inferredType(value: DatabaseCellValue): DatabasePropertyType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (Array.isArray(value)) return "multi_select";
  if (typeof value === "object" && value !== null) return "date";
  return "text";
}

function dateEditorValue(
  value: string | undefined,
  includeTime: boolean,
): string {
  if (!value || !includeTime) return value ?? "";
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "";
  const local = new Date(
    instant.getTime() - instant.getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}

function safeHref(type: DatabasePropertyType, value: string): string | null {
  if (type === "email") {
    return /^[^\s@]+@[^\s@]+$/.test(value) ? `mailto:${value}` : null;
  }
  if (type === "phone") {
    return /^[+0-9(). -]{3,}$/.test(value) ? `tel:${value}` : null;
  }
  if (type !== "url" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function CellValue({
  property,
  text,
}: {
  property: DatabaseProperty;
  text: string;
}) {
  const renderer = databasePropertyRegistration(property.type).renderer;
  const href = renderer === "link" ? safeHref(property.type, text) : null;
  if (!href) {
    return (
      <span className="truncate">
        {text || (property.type === "title" ? "Untitled" : "Empty")}
      </span>
    );
  }
  return (
    <a
      className="truncate text-primary underline-offset-2 hover:underline"
      href={href}
      rel="noreferrer"
      target={property.type === "url" ? "_blank" : undefined}
    >
      {text}
    </a>
  );
}

function DateEditor({
  property,
  row,
  value,
  onCancel,
  onFailed,
  onSaved,
  onSave,
}: {
  property: DatabaseProperty;
  row: DatabaseRow;
  value: DatabaseCellValue;
  onCancel: () => void;
  onFailed: (failure: FailedSave, message: string) => void;
  onSaved: (saved: DatabaseRow) => void;
  onSave: DatabaseCellProps["onSave"];
}) {
  const current =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as DatabaseDateValue)
      : null;
  const [includeTime, setIncludeTime] = React.useState(
    current?.includeTime ?? false,
  );
  const [start, setStart] = React.useState(() =>
    dateEditorValue(current?.start, current?.includeTime ?? false),
  );
  const [end, setEnd] = React.useState(() =>
    dateEditorValue(current?.end, current?.includeTime ?? false),
  );
  const [saving, setSaving] = React.useState(false);
  const startId = `database-date-${row.id}-${property.id}-start`;
  const endId = `database-date-${row.id}-${property.id}-end`;
  const inputType = includeTime ? "datetime-local" : "date";
  const normalized = (value: string) =>
    includeTime && value ? new Date(value).toISOString() : value;
  const saveValue = async (value: DatabaseCellValue) => {
    const values = { ...row.values, [property.id]: value };
    const failure = { values, baseEventId: row.eventId };
    setSaving(true);
    try {
      onSaved(await onSave(values, row.eventId));
    } catch (error) {
      onFailed(
        failure,
        error instanceof Error ? error.message : "Couldn't save this date.",
      );
    } finally {
      setSaving(false);
    }
  };
  const submit = async () => {
    try {
      const parsed = parseDatabaseCellDraft(
        property,
        JSON.stringify({
          start: normalized(start),
          ...(end ? { end: normalized(end) } : {}),
          includeTime,
        }),
      );
      await saveValue(parsed);
    } catch (error) {
      onFailed(
        { values: row.values, baseEventId: row.eventId },
        error instanceof Error ? error.message : "Enter a valid date.",
      );
    }
  };
  return (
    <div className="flex min-w-56 flex-col gap-2 rounded-lg border border-border bg-background p-2 shadow-lg">
      <label className="flex flex-col gap-1 text-xs" htmlFor={startId}>
        <span>Start</span>
        <Input
          aria-label={`Edit ${property.name} start`}
          id={startId}
          onChange={(event) => setStart(event.target.value)}
          type={inputType}
          value={start}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs" htmlFor={endId}>
        <span>End (optional)</span>
        <Input
          aria-label={`Edit ${property.name} end`}
          id={endId}
          onChange={(event) => setEnd(event.target.value)}
          type={inputType}
          value={end}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          checked={includeTime}
          onChange={(event) => {
            const next = event.target.checked;
            setIncludeTime(next);
            setStart((value) =>
              next && /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? `${value}T00:00`
                : !next
                  ? value.slice(0, 10)
                  : value,
            );
            setEnd((value) =>
              next && /^\d{4}-\d{2}-\d{2}$/.test(value)
                ? `${value}T00:00`
                : !next
                  ? value.slice(0, 10)
                  : value,
            );
          }}
          type="checkbox"
        />
        Include time
      </label>
      <div className="flex justify-end gap-2">
        <Button
          disabled={saving}
          onClick={() => void saveValue(null)}
          size="xs"
          type="button"
          variant="ghost"
        >
          Clear
        </Button>
        <Button onClick={onCancel} size="xs" type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={saving}
          onClick={() => void submit()}
          size="xs"
          type="button"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function DatabaseCell({
  knownPubkeys,
  property,
  row,
  width,
  relationContext,
  resolvedValue,
  onRestoreType,
  onSave,
}: DatabaseCellProps) {
  const presentation = databaseCellPresentation(property, row);
  const registration = databasePropertyRegistration(property.type);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(() =>
    editableDraft(presentation.value),
  );
  const [failure, setFailure] = React.useState<FailedSave | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const inputEditorRef = React.useRef<HTMLInputElement>(null);
  const selectEditorRef = React.useRef<HTMLSelectElement>(null);

  React.useEffect(() => {
    if (!editing && !failure) setDraft(editableDraft(presentation.value));
  }, [editing, failure, presentation.value]);
  React.useEffect(() => {
    if (!failure || failure.baseEventId === row.eventId) return;
    setFailure({
      values: {
        ...row.values,
        [property.id]: failure.values[property.id] ?? null,
      },
      baseEventId: row.eventId,
    });
    setError("A newer row was loaded. Retry to apply your edit to it.");
  }, [failure, property.id, row.eventId, row.values]);
  React.useEffect(() => {
    if (editing) {
      (registration.editor === "select"
        ? selectEditorRef
        : inputEditorRef
      ).current?.focus();
    }
  }, [editing, registration.editor]);

  const finishSaved = React.useCallback(
    (saved: DatabaseRow) => {
      setFailure(null);
      setError(null);
      setEditing(false);
      setDraft(editableDraft(saved.values[property.id] ?? null));
    },
    [property.id],
  );

  const saveSnapshot = React.useCallback(
    async (snapshot: FailedSave) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        finishSaved(await onSave(snapshot.values, snapshot.baseEventId));
      } catch (caught) {
        setFailure(snapshot);
        setError(
          caught instanceof Error ? caught.message : "Couldn't save this cell.",
        );
        setEditing(true);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [finishSaved, onSave],
  );

  const commitDraft = React.useCallback(() => {
    try {
      const value = parseDatabaseCellDraft(property, draft);
      const snapshot = {
        values: { ...row.values, [property.id]: value },
        baseEventId: row.eventId,
      };
      setFailure(snapshot);
      void saveSnapshot(snapshot);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Enter a valid value.",
      );
    }
  }, [draft, property, row.eventId, row.values, saveSnapshot]);

  const commitCheckbox = () => {
    const value = presentation.value !== true;
    const snapshot = {
      values: { ...row.values, [property.id]: value },
      baseEventId: row.eventId,
    };
    setFailure(snapshot);
    void saveSnapshot(snapshot);
  };

  const commitValue = (value: DatabaseCellValue) => {
    const snapshot = {
      values: { ...row.values, [property.id]: value },
      baseEventId: row.eventId,
    };
    setFailure(snapshot);
    void saveSnapshot(snapshot);
  };

  const style = { width, minWidth: width };
  if (property.type === "formula" || property.type === "rollup") {
    const value = resolvedValue ?? null;
    const computedError = isDatabaseComputedError(value);
    const text = databaseComputedValueText(value) || "Empty";
    return (
      <div
        className={`flex h-full items-center overflow-hidden border-r border-border/50 px-2 text-xs ${computedError ? "text-destructive" : "text-muted-foreground"}`}
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
        title={text}
      >
        <span className="truncate" role={computedError ? "alert" : undefined}>
          {text}
        </span>
      </div>
    );
  }

  if (property.type === "relation" && relationContext) {
    return (
      <div
        className="flex h-full items-center overflow-hidden border-r border-border/50 px-2 text-xs"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <DatabaseRelationCell
          context={relationContext}
          property={property}
          resolvedValue={resolvedValue ?? presentation.value}
          row={row}
        />
      </div>
    );
  }
  if (presentation.mismatch && !editing) {
    const restoreType =
      databaseCellRecoveryType(property, presentation.value) ??
      inferredType(presentation.value);
    return (
      <div
        className="flex h-full items-center gap-2 overflow-hidden border-r border-border/50 px-2 text-xs"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <span className="min-w-0 flex-1 truncate" title={presentation.text}>
          {presentation.text}
        </span>
        <span className="shrink-0 text-amber-600">Type mismatch</span>
        <Button
          aria-label={`Edit ${property.name} as ${databasePropertyLabel(property.type).toLowerCase()}`}
          onClick={() => setEditing(true)}
          size="xs"
          type="button"
          variant="outline"
        >
          Edit
        </Button>
        <Button
          aria-label={`Restore ${property.name} as ${databasePropertyLabel(restoreType).toLowerCase()}`}
          onClick={() => void onRestoreType(restoreType)}
          size="xs"
          type="button"
          variant="outline"
        >
          Restore
        </Button>
      </div>
    );
  }

  if (presentation.readOnly) {
    return (
      <div
        className="flex h-full items-center overflow-hidden border-r border-border/50 px-2 text-xs text-muted-foreground"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
        title={presentation.text}
      >
        <span className="truncate">{presentation.text || "Unknown"}</span>
      </div>
    );
  }

  if (registration.editor === "checkbox") {
    const pending = failure?.values[property.id];
    return (
      <div
        className="flex h-full items-center gap-2 border-r border-border/50 px-3"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <input
          aria-label={`Edit ${property.name}`}
          checked={failure ? pending === true : presentation.value === true}
          disabled={saving}
          onChange={commitCheckbox}
          type="checkbox"
        />
        <CellSaveFailure
          error={error}
          failure={failure}
          name={property.name}
          onRetry={(snapshot) => void saveSnapshot(snapshot)}
          saving={saving}
        />
      </div>
    );
  }

  if (editing && registration.editor === "date" && property.type === "date") {
    return (
      <div
        className="relative h-full border-r border-border/50 px-2 py-1"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <div className="absolute left-1 top-1 z-20">
          <DateEditor
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
            onFailed={(nextFailure, message) => {
              setFailure(nextFailure);
              setError(message);
            }}
            onSave={onSave}
            onSaved={finishSaved}
            property={property}
            row={row}
            value={presentation.value}
          />
          <CellSaveFailure
            error={error}
            failure={failure}
            name={property.name}
            onRetry={(snapshot) => void saveSnapshot(snapshot)}
            saving={saving}
          />
        </div>
      </div>
    );
  }

  if (
    editing &&
    registration.editor === "select" &&
    (property.type === "select" || property.type === "status")
  ) {
    const choices = property.options.choices;
    const selectedValue = failure
      ? failure.values[property.id]
      : presentation.value;
    return (
      <div
        className="flex h-full items-center border-r border-border/50 px-1"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <select
          aria-label={`Edit ${property.name}`}
          className="h-7 min-w-0 flex-1 rounded border border-input/40 bg-background px-1 text-xs"
          disabled={saving}
          onChange={(event) => {
            try {
              commitValue(parseDatabaseCellDraft(property, event.target.value));
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Choose an available choice.",
              );
            }
          }}
          ref={selectEditorRef}
          value={typeof selectedValue === "string" ? selectedValue : ""}
        >
          <option value="">Empty</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.name}
            </option>
          ))}
        </select>
        <CellSaveFailure
          error={error}
          failure={failure}
          name={property.name}
          onRetry={(snapshot) => void saveSnapshot(snapshot)}
          saving={saving}
        />
      </div>
    );
  }

  if (
    editing &&
    registration.editor === "multi_select" &&
    property.type === "multi_select"
  ) {
    const selected = new Set(
      Array.isArray(presentation.value)
        ? presentation.value.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );
    const draftSelected = new Set(
      draft
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    return (
      <div
        className="relative h-full border-r border-border/50 px-1"
        data-testid={`database-cell-${row.id}-${property.id}`}
        role="gridcell"
        style={style}
        tabIndex={-1}
      >
        <div className="absolute left-1 top-1 z-20 flex min-w-48 flex-col gap-1 rounded-lg border border-border bg-background p-2 shadow-lg">
          {property.options.choices.length ? (
            property.options.choices.map((choice) => (
              <label
                className="flex items-center gap-2 text-xs"
                key={choice.id}
              >
                <input
                  checked={
                    draftSelected.has(choice.id) ||
                    (!draft && selected.has(choice.id))
                  }
                  onChange={(event) => {
                    const next = new Set(draft ? draftSelected : selected);
                    if (event.target.checked) next.add(choice.id);
                    else next.delete(choice.id);
                    setDraft([...next].join(","));
                  }}
                  type="checkbox"
                />
                {choice.name}
              </label>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">
              Add choices in the column header first.
            </span>
          )}
          <div className="flex justify-end gap-1 pt-1">
            <Button
              onClick={() => setEditing(false)}
              size="xs"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                commitValue(draftSelected.size ? [...draftSelected] : null)
              }
              size="xs"
              type="button"
            >
              Save
            </Button>
          </div>
          <CellSaveFailure
            error={error}
            failure={failure}
            name={property.name}
            onRetry={(snapshot) => void saveSnapshot(snapshot)}
            saving={saving}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-w-0 flex-col justify-center border-r border-border/50 px-1"
      data-testid={`database-cell-${row.id}-${property.id}`}
      onClick={() => {
        if (!editing) setEditing(true);
      }}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          setEditing(true);
        }
      }}
      role="gridcell"
      style={style}
      tabIndex={-1}
    >
      {editing ? (
        <div className="flex min-w-0 items-center gap-1">
          <Input
            aria-label={`Edit ${property.name}`}
            className="h-7 min-w-0 flex-1 rounded px-1.5 text-xs"
            disabled={saving}
            list={
              property.type === "person" ? `people-${property.id}` : undefined
            }
            onBlur={() => {
              if (!savingRef.current && !error) commitDraft();
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === "Escape") {
                setEditing(false);
                setFailure(null);
                setError(null);
                setDraft(editableDraft(presentation.value));
              }
            }}
            ref={inputEditorRef}
            value={draft}
          />
          {property.type === "person" ? (
            <datalist id={`people-${property.id}`}>
              {knownPubkeys.map((pubkey) => (
                <option key={pubkey} value={pubkey} />
              ))}
            </datalist>
          ) : null}
          <CellSaveFailure
            error={error}
            failure={failure}
            name={property.name}
            onRetry={(snapshot) => void saveSnapshot(snapshot)}
            saving={saving}
          />
        </div>
      ) : (
        <button
          aria-label={`Edit ${property.name}`}
          className="flex h-full min-w-0 items-center px-1 text-left text-xs hover:bg-muted/40"
          data-database-cell-trigger="true"
          onClick={() => setEditing(true)}
          type="button"
        >
          <CellValue property={property} text={presentation.text} />
        </button>
      )}
    </div>
  );
}
