import {
  isDatabaseDateOnly,
  isDatabaseTimedInstant,
} from "./databaseDateValue";

/** Maximum columns accepted from one canonical CSV table. */
export const MAX_COLUMNS = 1_000;
/** Maximum rows accepted from one canonical CSV table. */
export const MAX_ROWS_PER_TABLE = 30_000;
/** Maximum visited cells accepted from one canonical CSV table. */
export const MAX_CELLS_PER_TABLE = 1_000_000;
/** Maximum UTF-8 bytes accepted for a source path, header, or cell. */
export const MAX_CELL_UTF8_BYTES = 262_144;
/** Maximum cumulative UTF-8 bytes across path, headers, and cells. */
export const MAX_TABLE_UTF8_BYTES = 67_108_864;

/** Minimum nonempty observations for select-like inference. */
export const SELECT_MIN_NONEMPTY = 8;
/** Minimum distinct labels for select-like inference. */
export const SELECT_MIN_CHOICES = 2;
/** Maximum distinct labels for select-like inference. */
export const SELECT_MAX_CHOICES = 20;
/** Maximum distinct-label ratio for select-like inference. */
export const SELECT_MAX_DISTINCT_RATIO = 0.25;
/** Maximum UTF-8 bytes in one inferred choice label. */
export const CHOICE_MAX_UTF8_BYTES = 128;
/** The only delimiter recognized for inferred multi-select cells. */
export const MULTI_SELECT_DELIMITER = ", ";
/** Maximum tokens accepted from one inferred multi-select cell. */
export const MULTI_SELECT_MAX_TOKENS_PER_CELL = 20;

/** Property types Stage 6 may infer without semantic metadata. */
export type NotionDbInferredType =
  | "title"
  | "text"
  | "number"
  | "date"
  | "checkbox"
  | "url"
  | "select"
  | "multi_select";

/** Source-safe reason codes describing each inference decision. */
export type NotionDbInferenceReason =
  | "title"
  | "no-data"
  | "strict-date"
  | "strict-number"
  | "strict-checkbox"
  | "strict-url"
  | "conservative-select"
  | "conservative-multi-select"
  | "mixed-date-mode"
  | "mixed-checkbox-notation"
  | "mixed-scalar"
  | "recognizable-scalar-rejected"
  | "precision-loss"
  | "too-few-observations"
  | "too-few-choices"
  | "high-cardinality"
  | "ambiguous-delimiter"
  | "unsafe-choice";

/** Internal typed decision for one complete non-title source column. */
export type NotionDbColumnInference = {
  type: Exclude<NotionDbInferredType, "title">;
  reason: NotionDbInferenceReason;
  nonemptyCount: number;
  distinctCount: number;
  rejectedCount: number;
  numberFormat?: "integer" | "decimal";
  dateMode?: "date-only" | "timed";
  labels?: string[];
};

type ScalarMatch<T> =
  | { kind: "accepted"; value: T }
  | { kind: "rejected"; reason?: "precision-loss" }
  | { kind: "ordinary" };

const textEncoder = new TextEncoder();
const NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const NUMERIC_NEAR_MISS = [
  /^[+-]?\d+[eE][+-]?\d+$/,
  /^\+\d+(?:\.\d+)?$/,
  /^-?0\d+(?:\.\d+)?$/,
  /^-?(?:\d+\.|\.\d+)$/,
  /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,
  /^[₩$€£]-?\d+(?:\.\d+)?$/,
  /^-?\d+(?:\.\d+)?[%₩$€£]$/,
  /^(?:NaN|[+-]?Infinity)$/,
] as const;

function isControlOrNewline(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function classifyDate(value: string): ScalarMatch<"date-only" | "timed"> {
  if (isDatabaseDateOnly(value)) {
    return { kind: "accepted", value: "date-only" };
  }
  if (isDatabaseTimedInstant(value)) {
    return { kind: "accepted", value: "timed" };
  }
  const trimmed = value.trim();
  if (
    /^\d{4}-\d{2}-\d{2}/.test(value) ||
    (trimmed !== value && /^\d{4}-\d{2}-\d{2}/.test(trimmed))
  ) {
    return { kind: "rejected" };
  }
  return { kind: "ordinary" };
}

function normalizedDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function classifyNumber(value: string): ScalarMatch<number> {
  if (NUMBER_PATTERN.test(value)) {
    const normalized = normalizedDecimal(value);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || String(parsed) !== normalized) {
      return { kind: "rejected", reason: "precision-loss" };
    }
    return { kind: "accepted", value: parsed };
  }
  const trimmed = value.trim();
  if (
    (trimmed !== value && NUMBER_PATTERN.test(trimmed)) ||
    NUMERIC_NEAR_MISS.some((pattern) => pattern.test(value))
  ) {
    return { kind: "rejected" };
  }
  return { kind: "ordinary" };
}

function classifyCheckbox(
  value: string,
): ScalarMatch<{ family: "word" | "symbol"; value: boolean }> {
  if (value === "Yes" || value === "No") {
    return {
      kind: "accepted",
      value: { family: "word", value: value === "Yes" },
    };
  }
  if (value === "☑" || value === "☐") {
    return {
      kind: "accepted",
      value: { family: "symbol", value: value === "☑" },
    };
  }
  if (/^(?:yes|no|true|false)$/i.test(value)) {
    return { kind: "rejected" };
  }
  return { kind: "ordinary" };
}

function classifyUrl(value: string): ScalarMatch<string> {
  const lowerPrefix =
    value.startsWith("http://") || value.startsWith("https://");
  const trimmed = value.trim();
  const urlLike =
    /^https?:/i.test(trimmed) ||
    /^(?:\/\/|\.{0,2}\/|[?#])/.test(trimmed) ||
    /^(?:file|data|javascript):/i.test(trimmed);
  if (!lowerPrefix) {
    return urlLike ? { kind: "rejected" } : { kind: "ordinary" };
  }
  if (/\s/.test(value) || isControlOrNewline(value)) {
    return { kind: "rejected" };
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return { kind: "rejected" };
    }
    return { kind: "accepted", value };
  } catch {
    return { kind: "rejected" };
  }
}

function ordinaryLabel(value: string): boolean {
  return (
    classifyDate(value).kind === "ordinary" &&
    classifyNumber(value).kind === "ordinary" &&
    classifyCheckbox(value).kind === "ordinary" &&
    classifyUrl(value).kind === "ordinary"
  );
}

function safeChoice(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    textEncoder.encode(value).length <= CHOICE_MAX_UTF8_BYTES &&
    !isControlOrNewline(value) &&
    !value.includes(",") &&
    ordinaryLabel(value)
  );
}

function textInference(
  reason: NotionDbInferenceReason,
  values: readonly string[],
  rejectedCount = 0,
): NotionDbColumnInference {
  return {
    type: "text",
    reason,
    nonemptyCount: values.length,
    distinctCount: new Set(values).size,
    rejectedCount,
  };
}

function allAccepted<T>(matches: readonly ScalarMatch<T>[]): matches is Array<{
  kind: "accepted";
  value: T;
}> {
  return matches.every((match) => match.kind === "accepted");
}

function categoricalFallbackReason(
  values: readonly string[],
): NotionDbInferenceReason {
  if (values.some((value) => value.includes(","))) return "ambiguous-delimiter";
  if (values.length < SELECT_MIN_NONEMPTY) return "too-few-observations";
  const distinctCount = new Set(values).size;
  if (distinctCount < SELECT_MIN_CHOICES) return "too-few-choices";
  if (distinctCount > SELECT_MAX_CHOICES || distinctCount * 4 > values.length) {
    return "high-cardinality";
  }
  return "unsafe-choice";
}

function inferMultiSelect(
  values: readonly string[],
): NotionDbColumnInference | null {
  if (!values.some((value) => value.includes(MULTI_SELECT_DELIMITER))) {
    return null;
  }
  if (values.length < SELECT_MIN_NONEMPTY) {
    return textInference("too-few-observations", values);
  }
  const singletonTokens = new Set<string>();
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  const multiTokens: string[] = [];
  let totalTokenOccurrences = 0;
  for (const value of values) {
    const tokens = value.split(MULTI_SELECT_DELIMITER);
    if (tokens.length > MULTI_SELECT_MAX_TOKENS_PER_CELL) {
      return textInference("unsafe-choice", values);
    }
    const perCell = new Set<string>();
    for (const token of tokens) {
      totalTokenOccurrences += 1;
      if (!safeChoice(token) || perCell.has(token)) {
        return textInference("unsafe-choice", values);
      }
      perCell.add(token);
      if (!seenLabels.has(token)) {
        seenLabels.add(token);
        labels.push(token);
      }
    }
    if (tokens.length === 1) singletonTokens.add(tokens[0]);
    else multiTokens.push(...tokens);
  }
  if (singletonTokens.size === 0) {
    return textInference("too-few-observations", values);
  }
  if (multiTokens.some((token) => !singletonTokens.has(token))) {
    return textInference("unsafe-choice", values);
  }
  if (
    labels.length < SELECT_MIN_CHOICES ||
    labels.length > SELECT_MAX_CHOICES ||
    labels.length * 4 > totalTokenOccurrences
  ) {
    return textInference("high-cardinality", values);
  }
  return {
    type: "multi_select",
    reason: "conservative-multi-select",
    nonemptyCount: values.length,
    distinctCount: labels.length,
    rejectedCount: 0,
    labels,
  };
}

function inferSelect(values: readonly string[]): NotionDbColumnInference {
  const labels = [...new Set(values)];
  if (
    values.length < SELECT_MIN_NONEMPTY ||
    labels.length < SELECT_MIN_CHOICES ||
    labels.length > SELECT_MAX_CHOICES ||
    labels.length * 4 > values.length ||
    labels.some((label) => !safeChoice(label))
  ) {
    return textInference(categoricalFallbackReason(values), values);
  }
  return {
    type: "select",
    reason: "conservative-select",
    nonemptyCount: values.length,
    distinctCount: labels.length,
    rejectedCount: 0,
    labels,
  };
}

/** Applies the approved all-nonempty inference policy to one non-title column. */
export function inferNotionDbColumn(
  columnValues: readonly string[],
): NotionDbColumnInference {
  const values = columnValues.filter((value) => value !== "");
  if (values.length === 0) return textInference("no-data", values);

  const dates = values.map(classifyDate);
  const rejectedDates = dates.filter(
    (match) => match.kind === "rejected",
  ).length;
  if (rejectedDates > 0) {
    return textInference("recognizable-scalar-rejected", values, rejectedDates);
  }
  const acceptedDates = dates.filter((match) => match.kind === "accepted");
  if (acceptedDates.length > 0) {
    if (!allAccepted(dates)) return textInference("mixed-scalar", values);
    const modes = new Set(dates.map((match) => match.value));
    if (modes.size !== 1) return textInference("mixed-date-mode", values);
    return {
      type: "date",
      reason: "strict-date",
      nonemptyCount: values.length,
      distinctCount: new Set(values).size,
      rejectedCount: 0,
      dateMode: dates[0].value,
    };
  }

  const numbers = values.map(classifyNumber);
  const rejectedNumbers = numbers.filter((match) => match.kind === "rejected");
  if (rejectedNumbers.length > 0) {
    const reason = rejectedNumbers.some(
      (match) => match.kind === "rejected" && match.reason === "precision-loss",
    )
      ? "precision-loss"
      : "recognizable-scalar-rejected";
    return textInference(reason, values, rejectedNumbers.length);
  }
  const acceptedNumbers = numbers.filter((match) => match.kind === "accepted");
  if (acceptedNumbers.length > 0) {
    if (!allAccepted(numbers)) return textInference("mixed-scalar", values);
    return {
      type: "number",
      reason: "strict-number",
      nonemptyCount: values.length,
      distinctCount: new Set(values).size,
      rejectedCount: 0,
      numberFormat: values.some((value) => value.includes("."))
        ? "decimal"
        : "integer",
    };
  }

  const checkboxes = values.map(classifyCheckbox);
  const rejectedCheckboxes = checkboxes.filter(
    (match) => match.kind === "rejected",
  ).length;
  if (rejectedCheckboxes > 0) {
    return textInference(
      "recognizable-scalar-rejected",
      values,
      rejectedCheckboxes,
    );
  }
  const acceptedCheckboxes = checkboxes.filter(
    (match) => match.kind === "accepted",
  );
  if (acceptedCheckboxes.length > 0) {
    if (!allAccepted(checkboxes)) return textInference("mixed-scalar", values);
    const families = new Set(checkboxes.map((match) => match.value.family));
    if (families.size !== 1) {
      return textInference("mixed-checkbox-notation", values);
    }
    return {
      type: "checkbox",
      reason: "strict-checkbox",
      nonemptyCount: values.length,
      distinctCount: new Set(values).size,
      rejectedCount: 0,
    };
  }

  const urls = values.map(classifyUrl);
  const rejectedUrls = urls.filter((match) => match.kind === "rejected").length;
  if (rejectedUrls > 0) {
    return textInference("recognizable-scalar-rejected", values, rejectedUrls);
  }
  const acceptedUrls = urls.filter((match) => match.kind === "accepted");
  if (acceptedUrls.length > 0) {
    if (!allAccepted(urls)) return textInference("mixed-scalar", values);
    return {
      type: "url",
      reason: "strict-url",
      nonemptyCount: values.length,
      distinctCount: new Set(values).size,
      rejectedCount: 0,
    };
  }

  return inferMultiSelect(values) ?? inferSelect(values);
}

/** Converts one already-inferred strict decimal without coercion. */
export function parseStrictNumber(value: string): number | null {
  const match = classifyNumber(value);
  return match.kind === "accepted" ? match.value : null;
}

/** Converts one already-inferred exact checkbox token. */
export function parseStrictCheckbox(value: string): boolean | null {
  const match = classifyCheckbox(value);
  return match.kind === "accepted" ? match.value.value : null;
}
