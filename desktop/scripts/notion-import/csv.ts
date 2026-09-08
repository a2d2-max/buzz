import { parse } from "csv-parse/sync";

import type {
  AmbiguousRelation,
  ImportedDatabase,
  UnresolvedRelation,
} from "./types.ts";
import type { ZipTextEntry } from "./zipReader.ts";

export type TitleIndex = Map<string, string[]>;

export type DatabaseConversion = {
  database: ImportedDatabase;
  relationColumnCount: number;
  relationResolvedCount: number;
  relationAmbiguousCount: number;
  ambiguousRelations: AmbiguousRelation[];
  relationUnresolvedCount: number;
  unresolvedRelations: UnresolvedRelation[];
  relationNonemptyCellCount: number;
  relationReferenceCount: number;
};

function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, " ⏎ ");
}

function escapeLinkLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/([[\]])/g, "\\$1")
    .replace(/\r?\n|\r/g, " ");
}

type RelationPart = { label: string; original: string };

function relationParts(value: string, titleIndex: TitleIndex): RelationPart[] {
  const trimmed = value.trim();
  if (titleIndex.has(trimmed)) return [{ label: trimmed, original: trimmed }];

  // Notion writes relation cells as one or more
  // `Title (percent-encoded path <32hex>.md|csv)` references. The target id is
  // not the related page id in this export, so only the label is authoritative.
  const referenceEnd = /[0-9a-f]{32}\.(?:md|csv)(?:[?#][^)]*)?\)(?:,\s*|$)/gi;
  const parts: RelationPart[] = [];
  let cursor = 0;
  for (const match of trimmed.matchAll(referenceEnd)) {
    const suffixStart = match.index ?? -1;
    const closingOffset = match[0].lastIndexOf(")");
    const closingIndex = suffixStart + closingOffset;
    let depth = 0;
    let openingIndex = -1;
    for (let index = closingIndex; index >= cursor; index -= 1) {
      const character = trimmed[index];
      if (character === ")") depth += 1;
      if (character === "(") {
        depth -= 1;
        if (depth === 0) {
          openingIndex = index;
          break;
        }
      }
    }
    if (
      openingIndex <= cursor ||
      !/\s/.test(trimmed[openingIndex - 1] ?? "") ||
      openingIndex + 1 >= suffixStart
    ) {
      return [{ label: trimmed, original: trimmed }];
    }
    const label = trimmed.slice(cursor, openingIndex).trim();
    if (!label) return [{ label: trimmed, original: trimmed }];
    parts.push({
      label,
      original: trimmed.slice(cursor, closingIndex + 1).trim(),
    });
    cursor = suffixStart + match[0].length;
  }
  return parts.length > 0 && trimmed.slice(cursor).trim() === ""
    ? parts
    : [{ label: trimmed, original: trimmed }];
}

function renderBodyCell({
  value,
  titleIndex,
  databaseIndex,
  rowIndex,
  columnIndex,
  ambiguousRelations,
  unresolvedRelations,
}: {
  value: string;
  titleIndex: TitleIndex;
  databaseIndex: number;
  rowIndex: number;
  columnIndex: number;
  ambiguousRelations: AmbiguousRelation[];
  unresolvedRelations: UnresolvedRelation[];
}): {
  markdown: string;
  resolved: number;
  ambiguous: number;
  unresolved: number;
} {
  if (value.trim() === "") {
    return { markdown: "", resolved: 0, ambiguous: 0, unresolved: 0 };
  }
  const parts = relationParts(value, titleIndex);

  let resolved = 0;
  let ambiguous = 0;
  let unresolved = 0;
  const rendered = parts.map((part) => {
    const candidates = titleIndex.get(part.label) ?? [];
    if (candidates.length === 1) {
      resolved += 1;
      return `[${escapeLinkLabel(part.label)}](/#/docs/${candidates[0]})`;
    }
    if (candidates.length > 1) {
      ambiguous += 1;
      ambiguousRelations.push({
        databaseIndex,
        rowIndex,
        columnIndex,
        candidatePageIds: [...candidates].sort(),
      });
    } else {
      unresolved += 1;
      unresolvedRelations.push({
        databaseIndex,
        rowIndex,
        columnIndex,
        reason: "title-not-found",
      });
    }
    return escapeTableCell(part.original);
  });
  return {
    markdown: rendered.join(", "),
    resolved,
    ambiguous,
    unresolved,
  };
}

function isCanonicalCsv(entryPath: string): boolean {
  return /_all\.csv$/i.test(entryPath);
}

export function convertCsvEntry({
  entry,
  databaseIndex,
  titleIndex,
  relationColumns,
}: {
  entry: ZipTextEntry;
  databaseIndex: number;
  titleIndex: TitleIndex;
  relationColumns: ReadonlySet<string>;
}): DatabaseConversion {
  const records = parse(entry.text, {
    bom: true,
    cast: false,
    columns: false,
    relax_column_count: false,
    skip_empty_lines: true,
  }) as string[][];
  const columns = records[0] ?? [];
  const rows = records.slice(1);
  const ambiguousRelations: AmbiguousRelation[] = [];
  const unresolvedRelations: UnresolvedRelation[] = [];
  let relationResolvedCount = 0;
  let relationAmbiguousCount = 0;
  let relationUnresolvedCount = 0;
  let relationNonemptyCellCount = 0;
  let relationReferenceCount = 0;
  const relationColumnIndexes = new Set<number>();
  columns.forEach((column, index) => {
    if (relationColumns.has(column)) relationColumnIndexes.add(index);
  });

  const renderedRows = rows.map((row, rowOffset) =>
    columns.map((_, columnIndex) => {
      const value = row[columnIndex] ?? "";
      if (!relationColumnIndexes.has(columnIndex))
        return escapeTableCell(value);
      if (value.trim() !== "") relationNonemptyCellCount += 1;
      const rendered = renderBodyCell({
        value,
        titleIndex,
        databaseIndex,
        rowIndex: rowOffset + 1,
        columnIndex,
        ambiguousRelations,
        unresolvedRelations,
      });
      relationResolvedCount += rendered.resolved;
      relationAmbiguousCount += rendered.ambiguous;
      relationUnresolvedCount += rendered.unresolved;
      relationReferenceCount +=
        rendered.resolved + rendered.ambiguous + rendered.unresolved;
      return rendered.markdown;
    }),
  );

  const header = `| ${columns.map(escapeTableCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const markdown =
    columns.length === 0
      ? ""
      : [
          header,
          separator,
          ...renderedRows.map((row) => `| ${row.join(" | ")} |`),
        ].join("\n");

  return {
    database: {
      sourcePath: entry.path,
      canonical: isCanonicalCsv(entry.path),
      hasMultilineCells: records.some((row) =>
        row.some((cell) => /\r|\n/.test(cell)),
      ),
      columns,
      rows,
      markdown,
    },
    relationColumnCount: relationColumnIndexes.size,
    relationResolvedCount,
    relationAmbiguousCount,
    relationUnresolvedCount,
    ambiguousRelations,
    unresolvedRelations,
    relationNonemptyCellCount,
    relationReferenceCount,
  };
}
