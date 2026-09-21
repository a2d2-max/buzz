import type { DatabaseCellValue, DatabaseDateValue } from "./databaseValue";
import { isDatabasePubkey, parseDatabaseCellValue } from "./databaseValue";
import { databaseDateValueMatches } from "./databaseDateValue";
import type { DatabaseRow } from "./databaseRowCodec";
import type {
  DatabaseProperty,
  DatabasePropertyType,
} from "./databaseSchemaCodec";
import { databasePropertyRegistration } from "./databasePropertyRegistry";

export type DatabaseCellPresentation = {
  value: DatabaseCellValue;
  text: string;
  mismatch: boolean;
  readOnly: boolean;
};

function automaticValue(
  property: DatabaseProperty,
  row: DatabaseRow,
): DatabaseCellValue | undefined {
  switch (property.type) {
    case "created_time":
      return row.createdAt;
    case "last_edited_time":
      return row.updatedAt;
    case "created_by":
      return row.createdBy;
    case "last_edited_by":
      return row.author;
    default:
      return undefined;
  }
}

function isDateValue(value: DatabaseCellValue): value is DatabaseDateValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "start" in value
  );
}

export function databaseCellValueMatches(
  property: DatabaseProperty,
  value: DatabaseCellValue,
): boolean {
  if (value === null) return true;
  switch (property.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof value === "string";
    case "select":
    case "status":
      return (
        typeof value === "string" &&
        property.options.choices.some((choice) => choice.id === value)
      );
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "multi_select":
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            typeof entry === "string" &&
            property.options.choices.some((choice) => choice.id === entry),
        )
      );
    case "person":
      return (
        Array.isArray(value) &&
        value.every(
          (entry) => typeof entry === "string" && isDatabasePubkey(entry),
        )
      );
    case "relation":
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
      );
    case "date":
      return isDateValue(value) && databaseDateValueMatches(value);
    case "checkbox":
      return typeof value === "boolean";
    case "files":
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "url" in entry &&
            typeof entry.url === "string",
        )
      );
    case "created_time":
    case "last_edited_time":
      return typeof value === "number";
    case "created_by":
    case "last_edited_by":
      return typeof value === "string";
    case "formula":
    case "rollup":
      return true;
  }
}

/** Finds the most meaningful persisted prior type for a mismatched raw value. */
export function databaseCellRecoveryType(
  property: DatabaseProperty,
  value: DatabaseCellValue,
): DatabasePropertyType | null {
  const matches = (property.priorDefinitions ?? []).filter((definition) =>
    databaseCellValueMatches(
      {
        id: property.id,
        name: property.name,
        ...definition,
      } as DatabaseProperty,
      value,
    ),
  );
  const specific = matches.find(
    (definition) => definition.type !== "text" && definition.type !== "title",
  );
  return specific?.type ?? matches[0]?.type ?? null;
}

function rawCellText(value: DatabaseCellValue): string {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Checked" : "Unchecked";
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        typeof entry === "string" ? entry : (entry.name ?? entry.url),
      )
      .join(", ");
  }
  return value.end ? `${value.start} – ${value.end}` : value.start;
}

function formattedCellText(
  property: DatabaseProperty,
  value: DatabaseCellValue,
): string {
  if (value === null) {
    return property.type === "created_by" ? "Unknown" : "";
  }
  if (property.type === "number" && typeof value === "number") {
    if (property.options.format === "percent") return `${value * 100}%`;
    if (property.options.format === "won") {
      return new Intl.NumberFormat("ko-KR", {
        style: "currency",
        currency: "KRW",
        maximumFractionDigits: 0,
      }).format(value);
    }
  }
  if (
    (property.type === "created_time" ||
      property.type === "last_edited_time") &&
    typeof value === "number"
  ) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
  }
  if (
    (property.type === "select" || property.type === "status") &&
    typeof value === "string"
  ) {
    return (
      property.options.choices.find((choice) => choice.id === value)?.name ??
      value
    );
  }
  if (property.type === "multi_select" && Array.isArray(value)) {
    return value
      .map(
        (id) =>
          property.options.choices.find((choice) => choice.id === id)?.name ??
          id,
      )
      .join(", ");
  }
  return rawCellText(value);
}

export function databaseCellPresentation(
  property: DatabaseProperty,
  row: DatabaseRow,
): DatabaseCellPresentation {
  const automatic = automaticValue(property, row);
  const value =
    automatic === undefined ? (row.values[property.id] ?? null) : automatic;
  const mismatch = !databaseCellValueMatches(property, value);
  return {
    value,
    text: mismatch ? rawCellText(value) : formattedCellText(property, value),
    mismatch,
    readOnly:
      databasePropertyRegistration(property.type).editor === "read_only",
  };
}

function parseDateDraft(draft: string): DatabaseDateValue {
  let raw: unknown;
  try {
    raw = JSON.parse(draft);
  } catch {
    throw new Error("Date value must include a start date.");
  }
  const parsed = parseDatabaseCellValue(raw);
  if (!parsed || !isDateValue(parsed)) {
    throw new Error("Date value must include a start date.");
  }
  if (!databaseDateValueMatches(parsed)) {
    throw new Error(
      parsed.includeTime
        ? "Enter a valid date and time with a timezone."
        : "Enter a valid date in YYYY-MM-DD format.",
    );
  }
  const start = parsed.includeTime ? Date.parse(parsed.start) : parsed.start;
  const end = parsed.end
    ? parsed.includeTime
      ? Date.parse(parsed.end)
      : parsed.end
    : undefined;
  if (end !== undefined && end < start) {
    throw new Error("End date cannot be before start date.");
  }
  return parsed;
}

export function parseDatabaseCellDraft(
  property: DatabaseProperty,
  draft: string,
): DatabaseCellValue {
  if (databasePropertyRegistration(property.type).editor === "read_only") {
    throw new Error("This property is updated automatically.");
  }
  switch (property.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return draft;
    case "select":
    case "status":
      if (!draft.trim()) return null;
      if (!property.options.choices.some((choice) => choice.id === draft)) {
        throw new Error("Choose an available choice.");
      }
      return draft;
    case "number": {
      if (!draft.trim()) return null;
      const value = Number(draft);
      if (!Number.isFinite(value)) throw new Error("Enter a valid number.");
      if (property.options.format === "integer" && !Number.isInteger(value)) {
        throw new Error("Enter a whole number.");
      }
      return property.options.format === "percent" ? value / 100 : value;
    }
    case "checkbox":
      if (draft === "true") return true;
      if (draft === "false") return false;
      throw new Error("Checkbox value must be true or false.");
    case "multi_select":
      if (!draft.trim()) return null;
      {
        const selected = draft
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (
          !selected.every((id) =>
            property.options.choices.some((choice) => choice.id === id),
          )
        ) {
          throw new Error("Choose only available choices.");
        }
        return [...new Set(selected)];
      }
    case "person": {
      if (!draft.trim()) return null;
      const pubkeys = draft
        .split(/[\s,]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      if (!pubkeys.every(isDatabasePubkey)) {
        throw new Error("People must be 64-character hex pubkeys.");
      }
      return [...new Set(pubkeys)];
    }
    case "date":
      if (!draft.trim()) return null;
      return parseDateDraft(draft);
    case "files":
    case "relation":
      throw new Error("This property editor is not available yet.");
    case "created_time":
    case "last_edited_time":
    case "created_by":
    case "last_edited_by":
    case "formula":
    case "rollup":
      throw new Error("This property is updated automatically.");
  }
}
