import { sha256 } from "@noble/hashes/sha2.js";

import {
  buildDatabaseRowEventInput,
  measureDatabaseRowContentBytes,
  parseDatabaseRowContent,
  type DatabaseRowContent,
} from "./databaseRowCodec";
import {
  buildDatabaseSchemaEventInput,
  measureDatabaseSchemaContentBytes,
  parseDatabaseSchemaContent,
  type DatabaseProperty,
  type DatabaseSchemaContent,
} from "./databaseSchemaCodec";
import {
  DATABASE_MAX_CONTENT_BYTES,
  isDatabaseEntityId,
  isDocPageId,
  type DatabaseCellValue,
} from "./databaseValue";
import {
  inferNotionDbColumn,
  MAX_CELLS_PER_TABLE,
  MAX_CELL_UTF8_BYTES,
  MAX_COLUMNS,
  MAX_ROWS_PER_TABLE,
  MAX_TABLE_UTF8_BYTES,
  MULTI_SELECT_DELIMITER,
  parseStrictCheckbox,
  parseStrictNumber,
  type NotionDbColumnInference,
  type NotionDbInferenceReason,
  type NotionDbInferredType,
} from "./notionDbInferencePolicy";

/** Stable namespace and report version for deterministic Stage 6 inference. */
export const NOTION_DB_INFERENCE_ALGORITHM_VERSION = "buzz:notion-db-infer:v1";

/** Structural subset of the importer format-v1 CSV table contract. */
export type NotionCsvTableInput = {
  sourcePath: string;
  canonical: boolean;
  hasMultilineCells: boolean;
  columns: string[];
  rows: string[][];
};

/** Exact optional identity and conversion provenance supplied by a caller. */
export type NotionDbConversionContext = {
  databaseId?: string;
  rowIds?: readonly string[];
  databaseName?: string;
  conversionTimestampMs?: number;
  docPageIds?: readonly (string | null)[];
};

/** Allowlisted source-safe conversion failure codes. */
export type NotionDbInferenceErrorCode =
  | "invalid-input"
  | "invalid-source-path"
  | "source-path-too-large"
  | "noncanonical-table"
  | "invalid-multiline-flag"
  | "invalid-column-count"
  | "invalid-header"
  | "header-too-large"
  | "too-many-rows"
  | "too-many-cells"
  | "ragged-row"
  | "invalid-cell"
  | "cell-too-large"
  | "table-too-large"
  | "invalid-context"
  | "duplicate-row-id"
  | "codec-validation-failed"
  | "schema-content-too-large"
  | "row-content-too-large";

/** Non-sensitive failure with optional zero-based source coordinates. */
export type NotionDbInferenceError = {
  code: NotionDbInferenceErrorCode;
  rowIndex?: number;
  columnIndex?: number;
};

/** Aggregate source-safe decision for one zero-based column. */
export type NotionDbColumnInferenceReport = {
  columnIndex: number;
  type: NotionDbInferredType;
  reason: NotionDbInferenceReason;
  nonemptyCount: number;
  distinctCount: number;
  rejectedCount: number;
};

/** Aggregate report that deliberately excludes paths, labels, and values. */
export type NotionDbInferenceReport = {
  algorithmVersion: typeof NOTION_DB_INFERENCE_ALGORITHM_VERSION;
  publishReady: boolean;
  databaseIdentity: "unknown" | "injected" | "source-path-derived";
  rowIdentity: "unknown" | "injected" | "position-derived";
  identityAlgorithm: "sha256-uuidv8";
  incrementalReimportSupported: boolean;
  timestampSource: "unknown" | "conversion-context";
  displaySource: "unknown" | "conversion-context" | "source-path";
  docPageMappingCount: number;
  hasMultilineCells: boolean;
  columnCount: number;
  rowCount: number;
  cellCount: number;
  inputUtf8Bytes: number;
  blankColumnIndices: number[];
  duplicateColumnIndices: number[];
  inferredColumns: NotionDbColumnInferenceReport[];
  fallbackReasonCounts: Partial<Record<NotionDbInferenceReason, number>>;
};

/** Complete deterministic snapshots or one non-partial safe failure. */
export type InferNotionDbSchemaResult =
  | {
      ok: true;
      schema: DatabaseSchemaContent & { id: string };
      rows: Array<DatabaseRowContent & { id: string; databaseId: string }>;
      report: NotionDbInferenceReport;
    }
  | {
      ok: false;
      error: NotionDbInferenceError;
      report: NotionDbInferenceReport;
    };

type ValidatedInput = {
  sourcePath: string;
  identityPath: string;
  hasMultilineCells: boolean;
  columns: string[];
  rows: string[][];
  inputUtf8Bytes: number;
};

type ValidatedContext = {
  databaseId: string;
  databaseIdentity: "injected" | "source-path-derived";
  rowIds: string[];
  rowIdentity: "injected" | "position-derived";
  databaseName: string;
  displaySource: "conversion-context" | "source-path";
  timestampMs: number;
  timestampSource: "unknown" | "conversion-context";
  docPageIds: Array<string | null>;
};

const textEncoder = new TextEncoder();

function emptyReport(): NotionDbInferenceReport {
  return {
    algorithmVersion: NOTION_DB_INFERENCE_ALGORITHM_VERSION,
    publishReady: false,
    databaseIdentity: "unknown",
    rowIdentity: "unknown",
    identityAlgorithm: "sha256-uuidv8",
    incrementalReimportSupported: false,
    timestampSource: "unknown",
    displaySource: "unknown",
    docPageMappingCount: 0,
    hasMultilineCells: false,
    columnCount: 0,
    rowCount: 0,
    cellCount: 0,
    inputUtf8Bytes: 0,
    blankColumnIndices: [],
    duplicateColumnIndices: [],
    inferredColumns: [],
    fallbackReasonCounts: {},
  };
}

function failure(
  report: NotionDbInferenceReport,
  code: NotionDbInferenceErrorCode,
  indices: Pick<NotionDbInferenceError, "rowIndex" | "columnIndex"> = {},
): InferNotionDbSchemaResult {
  return {
    ok: false,
    error: {
      code,
      ...(indices.rowIndex === undefined ? {} : { rowIndex: indices.rowIndex }),
      ...(indices.columnIndex === undefined
        ? {}
        : { columnIndex: indices.columnIndex }),
    },
    report: { ...report, publishReady: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringBytes(value: string): number {
  return textEncoder.encode(value).length;
}

function validateInput(
  candidate: unknown,
  report: NotionDbInferenceReport,
): ValidatedInput | InferNotionDbSchemaResult {
  if (!isRecord(candidate)) return failure(report, "invalid-input");
  const sourcePath = candidate.sourcePath;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return failure(report, "invalid-source-path");
  }
  const sourceBytes = stringBytes(sourcePath);
  if (sourceBytes > MAX_CELL_UTF8_BYTES) {
    return failure(report, "source-path-too-large");
  }
  report.inputUtf8Bytes = sourceBytes;
  if (candidate.canonical !== true)
    return failure(report, "noncanonical-table");
  if (typeof candidate.hasMultilineCells !== "boolean") {
    return failure(report, "invalid-multiline-flag");
  }
  report.hasMultilineCells = candidate.hasMultilineCells;
  if (
    !Array.isArray(candidate.columns) ||
    candidate.columns.length === 0 ||
    candidate.columns.length > MAX_COLUMNS
  ) {
    return failure(report, "invalid-column-count");
  }
  report.columnCount = candidate.columns.length;
  const columns: string[] = [];
  for (
    let columnIndex = 0;
    columnIndex < candidate.columns.length;
    columnIndex += 1
  ) {
    const header = candidate.columns[columnIndex];
    if (typeof header !== "string") {
      return failure(report, "invalid-header", { columnIndex });
    }
    const bytes = stringBytes(header);
    if (bytes > MAX_CELL_UTF8_BYTES) {
      return failure(report, "header-too-large", { columnIndex });
    }
    report.inputUtf8Bytes += bytes;
    if (report.inputUtf8Bytes > MAX_TABLE_UTF8_BYTES) {
      return failure(report, "table-too-large", { columnIndex });
    }
    columns.push(header);
  }
  if (!Array.isArray(candidate.rows)) return failure(report, "invalid-input");
  report.rowCount = candidate.rows.length;
  if (candidate.rows.length > MAX_ROWS_PER_TABLE) {
    return failure(report, "too-many-rows");
  }
  report.cellCount = candidate.rows.length * columns.length;
  if (report.cellCount > MAX_CELLS_PER_TABLE) {
    return failure(report, "too-many-cells");
  }
  const rows: string[][] = [];
  for (let rowIndex = 0; rowIndex < candidate.rows.length; rowIndex += 1) {
    const rawRow = candidate.rows[rowIndex];
    if (!Array.isArray(rawRow) || rawRow.length !== columns.length) {
      return failure(report, "ragged-row", { rowIndex });
    }
    const row: string[] = [];
    for (let columnIndex = 0; columnIndex < rawRow.length; columnIndex += 1) {
      const cell = rawRow[columnIndex];
      if (typeof cell !== "string") {
        return failure(report, "invalid-cell", { rowIndex, columnIndex });
      }
      const bytes = stringBytes(cell);
      if (bytes > MAX_CELL_UTF8_BYTES) {
        return failure(report, "cell-too-large", { rowIndex, columnIndex });
      }
      report.inputUtf8Bytes += bytes;
      if (report.inputUtf8Bytes > MAX_TABLE_UTF8_BYTES) {
        return failure(report, "table-too-large", { rowIndex, columnIndex });
      }
      row.push(cell);
    }
    rows.push(row);
  }
  return {
    sourcePath,
    identityPath: sourcePath.normalize("NFC"),
    hasMultilineCells: candidate.hasMultilineCells,
    columns,
    rows,
    inputUtf8Bytes: report.inputUtf8Bytes,
  };
}

function encodedIdentity(parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => `${stringBytes(part)}:${part}`).join("");
  return sha256(textEncoder.encode(encoded));
}

function deterministicUuid(domain: string, parts: readonly string[]): string {
  const bytes = encodedIdentity([
    NOTION_DB_INFERENCE_ALGORITHM_VERSION,
    domain,
    ...parts,
  ]).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fallbackDatabaseName(sourcePath: string): string {
  const basename = sourcePath.split("/").at(-1) ?? sourcePath;
  const withoutCsv = basename.replace(/_all\.csv$/, "");
  const withoutNotionId = withoutCsv.replace(/(?:\s+)?[0-9a-f]{32}$/i, "");
  return withoutNotionId.length > 0 ? withoutNotionId : "Imported database";
}

function validateContext(
  candidate: unknown,
  input: ValidatedInput,
  report: NotionDbInferenceReport,
): ValidatedContext | InferNotionDbSchemaResult {
  if (candidate !== undefined && !isRecord(candidate)) {
    return failure(report, "invalid-context");
  }
  const context = candidate ?? {};
  const allowed = new Set([
    "databaseId",
    "rowIds",
    "databaseName",
    "conversionTimestampMs",
    "docPageIds",
  ]);
  if (Object.keys(context).some((key) => !allowed.has(key))) {
    return failure(report, "invalid-context");
  }
  if (
    context.databaseId !== undefined &&
    (typeof context.databaseId !== "string" ||
      !isDatabaseEntityId(context.databaseId))
  ) {
    return failure(report, "invalid-context");
  }
  const databaseId =
    typeof context.databaseId === "string"
      ? context.databaseId
      : deterministicUuid("database", [input.identityPath]);
  const databaseIdentity =
    typeof context.databaseId === "string" ? "injected" : "source-path-derived";

  if (
    context.databaseName !== undefined &&
    (typeof context.databaseName !== "string" ||
      context.databaseName.length === 0)
  ) {
    return failure(report, "invalid-context");
  }
  const databaseName =
    typeof context.databaseName === "string"
      ? context.databaseName
      : fallbackDatabaseName(input.sourcePath);
  const displaySource =
    typeof context.databaseName === "string"
      ? "conversion-context"
      : "source-path";

  if (
    context.conversionTimestampMs !== undefined &&
    (typeof context.conversionTimestampMs !== "number" ||
      !Number.isFinite(context.conversionTimestampMs) ||
      context.conversionTimestampMs < 0)
  ) {
    return failure(report, "invalid-context");
  }
  const timestampMs =
    typeof context.conversionTimestampMs === "number"
      ? context.conversionTimestampMs
      : 0;
  const timestampSource =
    typeof context.conversionTimestampMs === "number"
      ? "conversion-context"
      : "unknown";

  let rowIds: string[];
  let rowIdentity: "injected" | "position-derived";
  if (context.rowIds !== undefined) {
    if (
      !Array.isArray(context.rowIds) ||
      context.rowIds.length !== input.rows.length
    ) {
      return failure(report, "invalid-context");
    }
    rowIds = [];
    const seen = new Set<string>();
    for (let rowIndex = 0; rowIndex < context.rowIds.length; rowIndex += 1) {
      const rowId = context.rowIds[rowIndex];
      if (typeof rowId !== "string" || !isDatabaseEntityId(rowId)) {
        return failure(report, "invalid-context", { rowIndex });
      }
      if (seen.has(rowId)) {
        return failure(report, "duplicate-row-id", { rowIndex });
      }
      seen.add(rowId);
      rowIds.push(rowId);
    }
    rowIdentity = "injected";
  } else {
    rowIds = input.rows.map((_, rowIndex) =>
      deterministicUuid("row", [databaseId, String(rowIndex)]),
    );
    rowIdentity = "position-derived";
  }

  let docPageIds: Array<string | null>;
  if (context.docPageIds !== undefined) {
    if (
      !Array.isArray(context.docPageIds) ||
      context.docPageIds.length !== input.rows.length
    ) {
      return failure(report, "invalid-context");
    }
    docPageIds = [];
    for (
      let rowIndex = 0;
      rowIndex < context.docPageIds.length;
      rowIndex += 1
    ) {
      const pageId = context.docPageIds[rowIndex];
      if (
        pageId !== null &&
        (typeof pageId !== "string" || !isDocPageId(pageId))
      ) {
        return failure(report, "invalid-context", { rowIndex });
      }
      docPageIds.push(pageId);
    }
  } else {
    docPageIds = input.rows.map(() => null);
  }

  return {
    databaseId,
    databaseIdentity,
    rowIds,
    rowIdentity,
    databaseName,
    displaySource,
    timestampMs,
    timestampSource,
    docPageIds,
  };
}

function headerIndices(columns: readonly string[]): {
  blankColumnIndices: number[];
  duplicateColumnIndices: number[];
} {
  const blankColumnIndices: number[] = [];
  const counts = new Map<string, number>();
  for (let index = 0; index < columns.length; index += 1) {
    const header = columns[index];
    if (header === "") blankColumnIndices.push(index);
    else counts.set(header, (counts.get(header) ?? 0) + 1);
  }
  const duplicateColumnIndices: number[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const header = columns[index];
    if (header !== "" && (counts.get(header) ?? 0) > 1) {
      duplicateColumnIndices.push(index);
    }
  }
  return { blankColumnIndices, duplicateColumnIndices };
}

function reportForColumns(
  input: ValidatedInput,
  inferences: readonly NotionDbColumnInference[],
  context: ValidatedContext,
  report: NotionDbInferenceReport,
): NotionDbInferenceReport {
  const titleValues = input.rows
    .map((row) => row[0])
    .filter((value) => value !== "");
  const inferredColumns: NotionDbColumnInferenceReport[] = [
    {
      columnIndex: 0,
      type: "title",
      reason: "title",
      nonemptyCount: titleValues.length,
      distinctCount: new Set(titleValues).size,
      rejectedCount: 0,
    },
    ...inferences.map((inference, offset) => ({
      columnIndex: offset + 1,
      type: inference.type,
      reason: inference.reason,
      nonemptyCount: inference.nonemptyCount,
      distinctCount: inference.distinctCount,
      rejectedCount: inference.rejectedCount,
    })),
  ];
  const fallbackReasonCounts: Partial<Record<NotionDbInferenceReason, number>> =
    {};
  for (const column of inferredColumns) {
    if (column.type !== "text") continue;
    fallbackReasonCounts[column.reason] =
      (fallbackReasonCounts[column.reason] ?? 0) + 1;
  }
  const indices = headerIndices(input.columns);
  return {
    ...report,
    publishReady: context.timestampSource === "conversion-context",
    databaseIdentity: context.databaseIdentity,
    rowIdentity: context.rowIdentity,
    incrementalReimportSupported: false,
    timestampSource: context.timestampSource,
    displaySource: context.displaySource,
    docPageMappingCount: context.docPageIds.filter((pageId) => pageId !== null)
      .length,
    hasMultilineCells: input.hasMultilineCells,
    columnCount: input.columns.length,
    rowCount: input.rows.length,
    cellCount: input.columns.length * input.rows.length,
    inputUtf8Bytes: input.inputUtf8Bytes,
    ...indices,
    inferredColumns,
    fallbackReasonCounts,
  };
}

function propertyForColumn(
  databaseId: string,
  columnIndex: number,
  header: string,
  inference: NotionDbColumnInference | null,
): DatabaseProperty {
  const id = deterministicUuid("property", [databaseId, String(columnIndex)]);
  const name = header === "" ? `Column ${columnIndex + 1}` : header;
  if (columnIndex === 0) return { id, name, type: "title" };
  if (!inference || inference.type === "text")
    return { id, name, type: "text" };
  if (inference.type === "number") {
    return {
      id,
      name,
      type: "number",
      options: { format: inference.numberFormat ?? "decimal" },
    };
  }
  if (inference.type === "select" || inference.type === "multi_select") {
    return {
      id,
      name,
      type: inference.type,
      options: {
        choices: (inference.labels ?? []).map((label) => ({
          id: deterministicUuid("choice", [id, label]),
          name: label,
        })),
      },
    };
  }
  return { id, name, type: inference.type };
}

function convertedValue(
  raw: string,
  property: DatabaseProperty,
  inference: NotionDbColumnInference | null,
): DatabaseCellValue {
  if (property.type === "title" || property.type === "text") return raw;
  if (raw === "") return property.type === "multi_select" ? [] : null;
  if (property.type === "number") {
    const parsed = parseStrictNumber(raw);
    if (parsed === null) throw new Error("number-conversion-drift");
    return parsed;
  }
  if (property.type === "date") {
    return {
      start: raw,
      includeTime: inference?.dateMode === "timed",
    };
  }
  if (property.type === "checkbox") {
    const parsed = parseStrictCheckbox(raw);
    if (parsed === null) throw new Error("checkbox-conversion-drift");
    return parsed;
  }
  if (property.type === "url") return raw;
  if (property.type === "select") {
    const selected = property.options.choices.find(
      (choice) => choice.name === raw,
    );
    if (!selected) throw new Error("select-conversion-drift");
    return selected.id;
  }
  if (property.type === "multi_select") {
    const choices = new Map(
      property.options.choices.map((choice) => [choice.name, choice.id]),
    );
    return raw.split(MULTI_SELECT_DELIMITER).map((label) => {
      const id = choices.get(label);
      if (!id) throw new Error("multi-select-conversion-drift");
      return id;
    });
  }
  throw new Error("unsupported-inferred-property");
}

/**
 * Converts one canonical importer CSV table into deterministic, codec-valid
 * database snapshots without reading clocks, randomness, files, or network.
 */
export function inferNotionDbSchema(
  csvTable: NotionCsvTableInput,
  context?: NotionDbConversionContext,
): InferNotionDbSchemaResult {
  const initialReport = emptyReport();
  const input = validateInput(csvTable, initialReport);
  if ("ok" in input) return input;
  const validatedContext = validateContext(context, input, initialReport);
  if ("ok" in validatedContext) return validatedContext;

  const inferences = input.columns
    .slice(1)
    .map((_, offset) =>
      inferNotionDbColumn(input.rows.map((row) => row[offset + 1])),
    );
  const report = reportForColumns(
    input,
    inferences,
    validatedContext,
    initialReport,
  );
  const properties = input.columns.map((header, columnIndex) =>
    propertyForColumn(
      validatedContext.databaseId,
      columnIndex,
      header,
      columnIndex === 0 ? null : inferences[columnIndex - 1],
    ),
  );
  const schema: DatabaseSchemaContent & { id: string } = {
    id: validatedContext.databaseId,
    name: validatedContext.databaseName,
    properties,
    views: [
      {
        id: deterministicUuid("view", [validatedContext.databaseId, "table"]),
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: properties.map((property) => property.id),
      },
    ],
    createdAt: validatedContext.timestampMs,
    updatedAt: validatedContext.timestampMs,
  };

  const rows: Array<DatabaseRowContent & { id: string; databaseId: string }> =
    [];
  try {
    for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
      const rawRow = input.rows[rowIndex];
      const values: Record<string, DatabaseCellValue> = {};
      for (
        let columnIndex = 0;
        columnIndex < properties.length;
        columnIndex += 1
      ) {
        const property = properties[columnIndex];
        values[property.id] = convertedValue(
          rawRow[columnIndex],
          property,
          columnIndex === 0 ? null : inferences[columnIndex - 1],
        );
      }
      rows.push({
        id: validatedContext.rowIds[rowIndex],
        databaseId: validatedContext.databaseId,
        values,
        docPageId: validatedContext.docPageIds[rowIndex],
        createdBy: null,
        createdAt: validatedContext.timestampMs,
        updatedAt: validatedContext.timestampMs,
      });
    }

    const { id: _schemaId, ...schemaContent } = schema;
    if (!parseDatabaseSchemaContent(schemaContent)) {
      return failure(report, "codec-validation-failed");
    }
    buildDatabaseSchemaEventInput(schema);
    if (
      measureDatabaseSchemaContentBytes(schema) > DATABASE_MAX_CONTENT_BYTES
    ) {
      return failure(report, "schema-content-too-large");
    }
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const {
        id: _rowId,
        databaseId: _databaseId,
        ...rowContent
      } = rows[rowIndex];
      if (!parseDatabaseRowContent(rowContent)) {
        return failure(report, "codec-validation-failed", { rowIndex });
      }
      buildDatabaseRowEventInput(rows[rowIndex]);
      if (
        measureDatabaseRowContentBytes(rows[rowIndex]) >
        DATABASE_MAX_CONTENT_BYTES
      ) {
        return failure(report, "row-content-too-large", { rowIndex });
      }
    }
  } catch {
    return failure(report, "codec-validation-failed");
  }

  return { ok: true, schema, rows, report };
}
