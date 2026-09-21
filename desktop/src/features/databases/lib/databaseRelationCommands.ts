import type { DatabaseRow } from "./databaseRowCodec";
import type { DatabaseProperty, DatabaseSchema } from "./databaseSchemaCodec";
import { addDatabaseProperty } from "./databaseSchemaCommands";
import type { DatabaseCellValue } from "./databaseValue";
import { isDatabaseEntityId, isDatabasePropertyId } from "./databaseValue";

const MAX_LINKS = 1_000;

export type DatabaseRelationPairPlan = {
  authoritativePropertyId: string;
  mirrorPropertyId: string;
  sourceDatabaseId: string;
  targetDatabaseId: string;
};

function validatePlan(plan: DatabaseRelationPairPlan): void {
  if (
    !isDatabaseEntityId(plan.sourceDatabaseId) ||
    !isDatabaseEntityId(plan.targetDatabaseId) ||
    !isDatabasePropertyId(plan.authoritativePropertyId) ||
    !isDatabasePropertyId(plan.mirrorPropertyId) ||
    plan.authoritativePropertyId === plan.mirrorPropertyId
  ) {
    throw new Error("Relation pairing coordinates are invalid.");
  }
}

/** Creates both stable property ids before either schema action is saved. */
export function newDatabaseRelationPairPlan(
  sourceDatabaseId: string,
  targetDatabaseId: string,
): DatabaseRelationPairPlan {
  const suffix = () => crypto.randomUUID().replaceAll("-", "");
  return {
    authoritativePropertyId: `property_${suffix()}`,
    mirrorPropertyId: `property_${suffix()}`,
    sourceDatabaseId,
    targetDatabaseId,
  };
}

/** Action 1: adds the owner relation with the planned reciprocal property id. */
export function addDatabaseAuthoritativeRelation<T extends DatabaseSchema>(
  schema: T,
  plan: DatabaseRelationPairPlan,
  name: string,
): T {
  validatePlan(plan);
  if (schema.id !== plan.sourceDatabaseId) {
    throw new Error("The relation source database changed.");
  }
  return addDatabaseProperty(schema, {
    id: plan.authoritativePropertyId,
    name: name.trim() || "Relation",
    type: "relation",
    options: {
      databaseId: plan.targetDatabaseId,
      direction: "authoritative",
      mirroredPropertyId: plan.mirrorPropertyId,
    },
  });
}

/** Action 2: adds the derived reciprocal after action 1 was accepted. */
export function addDatabaseMirrorRelation<T extends DatabaseSchema>(
  schema: T,
  plan: DatabaseRelationPairPlan,
  name: string,
): T {
  validatePlan(plan);
  if (schema.id !== plan.targetDatabaseId) {
    throw new Error("The relation target database changed.");
  }
  return addDatabaseProperty(schema, {
    id: plan.mirrorPropertyId,
    name: name.trim() || "Related from",
    type: "relation",
    options: {
      databaseId: plan.sourceDatabaseId,
      direction: "mirror",
      mirroredPropertyId: plan.authoritativePropertyId,
    },
  });
}

function normalizedLinks(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error("This relation cell has an incompatible value.");
  }
  const links: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (!isDatabaseEntityId(id))
      throw new Error(`Invalid related row id ${id}.`);
    if (!seen.has(id)) {
      seen.add(id);
      links.push(id);
    }
  }
  if (links.length > MAX_LINKS) {
    throw new Error(`Relations support at most ${MAX_LINKS} rows.`);
  }
  return links;
}

/** Applies an ordered authoritative relation draft to one complete row snapshot. */
export function setDatabaseRelationLinks(
  row: DatabaseRow,
  property: Extract<DatabaseProperty, { type: "relation" }>,
  links: readonly string[],
): Record<string, DatabaseCellValue> {
  if (property.options.direction !== "authoritative") {
    throw new Error(
      "Mirror relation values are derived from their source rows.",
    );
  }
  return {
    ...row.values,
    [property.id]: normalizedLinks([...links]),
  };
}

/** Builds one mirror-chip action that mutates exactly one authoritative row. */
export function setDatabaseMirrorRelationLink({
  connected,
  sourceProperty,
  sourceRow,
  targetRowId,
}: {
  connected: boolean;
  sourceProperty: Extract<DatabaseProperty, { type: "relation" }>;
  sourceRow: DatabaseRow;
  targetRowId: string;
}): {
  rowId: string;
  baseEventId: string;
  values: Record<string, DatabaseCellValue>;
} {
  if (sourceProperty.options.direction !== "authoritative") {
    throw new Error("The reciprocal source is not authoritative.");
  }
  if (!isDatabaseEntityId(targetRowId))
    throw new Error("Target row id is invalid.");
  const current = normalizedLinks(sourceRow.values[sourceProperty.id] ?? []);
  const next = connected
    ? [...current.filter((id) => id !== targetRowId), targetRowId]
    : current.filter((id) => id !== targetRowId);
  return {
    rowId: sourceRow.id,
    baseEventId: sourceRow.eventId,
    values: setDatabaseRelationLinks(sourceRow, sourceProperty, next),
  };
}
