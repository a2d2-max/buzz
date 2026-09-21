import { RotateCcw, Search, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import {
  databaseComputedValueText,
  isDatabaseComputedError,
} from "../lib/databaseComputedValue";
import type { DatabaseRow } from "../lib/databaseRowCodec";
import type {
  DatabaseProperty,
  DatabaseSchema,
} from "../lib/databaseSchemaCodec";
import {
  setDatabaseMirrorRelationLink,
  setDatabaseRelationLinks,
} from "../lib/databaseRelationCommands";
import type { DatabaseCellValue } from "../lib/databaseValue";
import type { DatabaseResolvedValue } from "../lib/databaseViewEngine";

export type DatabaseRelationCellContext = {
  lookupRow: (id: string) => Promise<DatabaseRow | undefined>;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  rows: ReadonlyMap<string, DatabaseRow>;
  schemas: ReadonlyMap<string, DatabaseSchema>;
};

type Failure =
  | { kind: "authoritative"; links: string[]; message: string }
  | {
      kind: "mirror";
      connected: boolean;
      message: string;
      sourceRowId: string;
    };

function rowTitle(
  row: DatabaseRow | undefined,
  schemas: ReadonlyMap<string, DatabaseSchema>,
): string {
  if (!row) return "Missing row";
  const title = schemas
    .get(row.databaseId)
    ?.properties.find((property) => property.type === "title");
  const value = title ? row.values[title.id] : null;
  return typeof value === "string" && value.trim() ? value : "Untitled";
}

/** Edits one authoritative relation row or one source row per mirror chip. */
export function DatabaseRelationCell({
  context,
  property,
  resolvedValue,
  row,
}: {
  context: DatabaseRelationCellContext;
  property: Extract<DatabaseProperty, { type: "relation" }>;
  resolvedValue: DatabaseResolvedValue;
  row: DatabaseRow;
}) {
  const [candidate, setCandidate] = React.useState("");
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);
  const links = Array.isArray(resolvedValue)
    ? resolvedValue.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const candidates = [...context.rows.values()]
    .filter(
      (candidateRow) =>
        !candidateRow.deleted &&
        candidateRow.databaseId === property.options.databaseId &&
        !links.includes(candidateRow.id),
    )
    .sort((left, right) =>
      rowTitle(left, context.schemas).localeCompare(
        rowTitle(right, context.schemas),
      ),
    );

  const saveAuthoritative = async (nextLinks: string[]) => {
    setSaving(true);
    setFailure(null);
    try {
      await context.onSaveRowValues(
        row.id,
        setDatabaseRelationLinks(row, property, nextLinks),
        row.eventId,
      );
    } catch (error) {
      setFailure({
        kind: "authoritative",
        links: nextLinks,
        message:
          error instanceof Error
            ? error.message
            : "Couldn't save this relation.",
      });
    } finally {
      setSaving(false);
    }
  };

  const saveMirror = async (sourceRowId: string, connected: boolean) => {
    const sourceRow = context.rows.get(sourceRowId);
    const sourceSchema = sourceRow
      ? context.schemas.get(sourceRow.databaseId)
      : undefined;
    const sourceProperty = sourceSchema?.properties.find(
      (
        candidate,
      ): candidate is Extract<DatabaseProperty, { type: "relation" }> =>
        candidate.id === property.options.mirroredPropertyId &&
        candidate.type === "relation" &&
        candidate.options.direction === "authoritative",
    );
    if (!sourceRow || !sourceProperty) {
      setFailure({
        kind: "mirror",
        connected,
        sourceRowId,
        message: "The authoritative source row or property is unavailable.",
      });
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const intent = setDatabaseMirrorRelationLink({
        connected,
        sourceProperty,
        sourceRow,
        targetRowId: row.id,
      });
      await context.onSaveRowValues(
        intent.rowId,
        intent.values,
        intent.baseEventId,
      );
    } catch (error) {
      setFailure({
        kind: "mirror",
        connected,
        sourceRowId,
        message:
          error instanceof Error
            ? error.message
            : "Couldn't update this reciprocal link.",
      });
    } finally {
      setSaving(false);
    }
  };

  if (isDatabaseComputedError(resolvedValue)) {
    return (
      <span
        className="flex min-w-0 items-center gap-1 text-2xs text-destructive"
        role="alert"
      >
        {databaseComputedValueText(resolvedValue)}
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
      {links.map((id) => {
        const candidateRow = context.rows.get(id);
        const linked =
          candidateRow &&
          !candidateRow.deleted &&
          candidateRow.databaseId === property.options.databaseId
            ? candidateRow
            : undefined;
        return (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs ${linked ? "bg-muted" : "bg-destructive/10 text-destructive"}`}
            key={id}
          >
            {rowTitle(linked, context.schemas)}
            {!linked ? (
              <button
                aria-label={`Look up missing related row ${id}`}
                disabled={saving}
                onClick={() => {
                  setLookupError(null);
                  void context.lookupRow(id).then(
                    (found) => {
                      if (!found)
                        setLookupError(`Related row ${id} was not found.`);
                    },
                    (error: unknown) =>
                      setLookupError(
                        error instanceof Error
                          ? error.message
                          : "Related row lookup failed.",
                      ),
                  );
                }}
                type="button"
              >
                <Search className="h-3 w-3" />
              </button>
            ) : null}
            <button
              aria-label={`Remove relation ${rowTitle(linked, context.schemas)}`}
              disabled={saving}
              onClick={() =>
                property.options.direction === "authoritative"
                  ? void saveAuthoritative(links.filter((link) => link !== id))
                  : void saveMirror(id, false)
              }
              type="button"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <select
        aria-label={`Choose row for ${property.name}`}
        className="h-7 min-w-28 rounded border border-input bg-background px-1 text-xs"
        disabled={saving}
        onChange={(event) => setCandidate(event.target.value)}
        value={candidate}
      >
        <option value="">Add row…</option>
        {candidates.map((candidateRow) => (
          <option key={candidateRow.id} value={candidateRow.id}>
            {rowTitle(candidateRow, context.schemas)}
          </option>
        ))}
      </select>
      <Button
        aria-label={`Add ${property.name} relation`}
        disabled={!candidate || saving}
        onClick={() => {
          if (!candidate) return;
          if (property.options.direction === "authoritative") {
            void saveAuthoritative([...links, candidate]);
          } else {
            void saveMirror(candidate, true);
          }
          setCandidate("");
        }}
        size="xs"
        type="button"
        variant="outline"
      >
        Add
      </Button>
      {failure ? (
        <span
          className="flex items-center gap-1 text-2xs text-destructive"
          role="alert"
        >
          {failure.message}
          <Button
            aria-label={`Retry ${property.name} relation`}
            disabled={saving}
            onClick={() =>
              failure.kind === "authoritative"
                ? void saveAuthoritative(failure.links)
                : void saveMirror(failure.sourceRowId, failure.connected)
            }
            size="xs"
            type="button"
            variant="outline"
          >
            <RotateCcw /> Retry
          </Button>
        </span>
      ) : lookupError ? (
        <span className="text-2xs text-destructive" role="alert">
          {lookupError}
        </span>
      ) : null}
    </div>
  );
}
