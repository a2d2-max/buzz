import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DATABASE_SCHEMA_D_PREFIX,
  COMMUNITY_DATABASE_SCHEMA_TAG,
  KIND_COMMUNITY_DATABASE_LEGACY,
  KIND_COMMUNITY_DATABASE_SCHEMA,
} from "@/shared/constants/kinds";

import {
  compareRelayVersions,
  hasOnlyObjectKeys,
  hasTag,
  isDatabaseEntityId,
  isDatabasePropertyId,
  isFiniteNonNegativeNumber,
  parseDatabaseCellValue,
  singleTagValue,
  type DatabaseCellValue,
} from "./databaseValue";

export { DATABASE_MAX_CONTENT_BYTES } from "./databaseValue";

export {
  COMMUNITY_DATABASE_SCHEMA_D_PREFIX,
  COMMUNITY_DATABASE_SCHEMA_TAG,
  KIND_COMMUNITY_DATABASE_LEGACY,
  KIND_COMMUNITY_DATABASE_SCHEMA,
} from "@/shared/constants/kinds";

export const COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS: readonly number[] = [
  KIND_COMMUNITY_DATABASE_SCHEMA,
  KIND_COMMUNITY_DATABASE_LEGACY,
];

export const DATABASE_PROPERTY_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "person",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "relation",
  "formula",
  "rollup",
  "files",
  "status",
] as const;
export type DatabasePropertyType = (typeof DATABASE_PROPERTY_TYPES)[number];

export const DATABASE_COMPUTED_RESULT_TYPES = [
  "number",
  "text",
  "boolean",
  "date",
  "number_list",
  "text_list",
  "boolean_list",
  "date_list",
] as const;
export type DatabaseComputedResultType =
  (typeof DATABASE_COMPUTED_RESULT_TYPES)[number];

export type DatabaseSelectChoice = {
  id: string;
  name: string;
  color?: string;
};

export type DatabaseStatusChoice = {
  id: string;
  name: string;
  group: "todo" | "doing" | "done";
  color?: string;
};

type DatabasePropertyBase = { id: string; name: string };
type SimplePropertyType = Exclude<
  DatabasePropertyType,
  | "number"
  | "select"
  | "multi_select"
  | "relation"
  | "formula"
  | "rollup"
  | "status"
>;

export type DatabasePropertyDefinition =
  | { type: SimplePropertyType }
  | {
      type: "number";
      options: { format: "integer" | "decimal" | "percent" | "won" };
    }
  | {
      type: "select" | "multi_select";
      options: { choices: DatabaseSelectChoice[] };
    }
  | {
      type: "relation";
      options: {
        databaseId: string;
        direction: "authoritative" | "mirror";
        mirroredPropertyId?: string;
      };
    }
  | {
      type: "formula";
      options: {
        expression: string;
        resultType?: DatabaseComputedResultType;
      };
    }
  | {
      type: "rollup";
      options: {
        relationPropertyId: string;
        targetPropertyId: string;
        calculation: "count" | "sum" | "avg" | "min" | "max" | "show";
        resultType?: DatabaseComputedResultType;
      };
    }
  | {
      type: "status";
      options: { choices: DatabaseStatusChoice[] };
    };

export type DatabaseProperty = DatabasePropertyBase &
  DatabasePropertyDefinition & {
    /** Most-recent-first definitions retained for lossless type restoration. */
    priorDefinitions?: DatabasePropertyDefinition[];
  };

export const DATABASE_FILTER_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_checked",
  "is_not_checked",
] as const;
export type DatabaseFilterOperator = (typeof DATABASE_FILTER_OPERATORS)[number];

export type DatabaseFilterRule = {
  kind: "rule";
  propertyId: string;
  operator: DatabaseFilterOperator;
  value?: DatabaseCellValue;
};
export type DatabaseFilterGroup = {
  kind: "group";
  operator: "and" | "or";
  filters: DatabaseFilter[];
};
export type DatabaseFilter = DatabaseFilterRule | DatabaseFilterGroup;

export type DatabaseSort = {
  propertyId: string;
  direction: "ascending" | "descending";
};
export type DatabaseGroup = DatabaseSort;
export type DatabaseView = {
  id: string;
  name: string;
  type: "table" | "board" | "calendar" | "gallery";
  filter?: DatabaseFilter;
  sorts: DatabaseSort[];
  group?: DatabaseGroup;
  visiblePropertyIds: string[];
  propertyWidths?: Record<string, number>;
};

export type DatabaseSchemaContent = {
  name: string;
  icon?: string;
  properties: DatabaseProperty[];
  views: DatabaseView[];
  createdAt: number;
  updatedAt: number;
  deleted?: true;
};

export type DatabaseSchema = Omit<DatabaseSchemaContent, "deleted"> & {
  id: string;
  author: string;
  eventId: string;
  eventCreatedAt: number;
  eventKind: number;
  deleted: boolean;
};

const NUMBER_FORMATS = new Set(["integer", "decimal", "percent", "won"]);
const STATUS_GROUPS = new Set(["todo", "doing", "done"]);
const RELATION_DIRECTIONS = new Set(["authoritative", "mirror"]);
const ROLLUP_CALCULATIONS = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "show",
]);
const COMPUTED_RESULT_TYPES = new Set<string>(DATABASE_COMPUTED_RESULT_TYPES);
const VIEW_TYPES = new Set(["table", "board", "calendar", "gallery"]);
const SORT_DIRECTIONS = new Set(["ascending", "descending"]);
const FILTER_OPERATORS = new Set<string>(DATABASE_FILTER_OPERATORS);
const MAX_FILTER_DEPTH = 8;
const MAX_FILTERS_PER_GROUP = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseChoice(value: unknown): DatabaseSelectChoice | null {
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, ["id", "name", "color"]) ||
    typeof value.id !== "string" ||
    !isDatabasePropertyId(value.id)
  )
    return null;
  if (typeof value.name !== "string") return null;
  if (value.color !== undefined && typeof value.color !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.color === "string" ? { color: value.color } : {}),
  };
}

function parseChoices(value: unknown): DatabaseSelectChoice[] | null {
  if (!Array.isArray(value)) return null;
  const choices: DatabaseSelectChoice[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const choice = parseChoice(raw);
    if (!choice || ids.has(choice.id)) return null;
    ids.add(choice.id);
    choices.push(choice);
  }
  return choices;
}

function parseActiveProperty(value: unknown): DatabaseProperty | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !isDatabasePropertyId(value.id))
    return null;
  if (typeof value.name !== "string") return null;
  if (
    typeof value.type !== "string" ||
    !(DATABASE_PROPERTY_TYPES as readonly string[]).includes(value.type)
  )
    return null;
  const base = { id: value.id, name: value.name };
  if (value.type === "number") {
    if (
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !hasOnlyObjectKeys(value.options, ["format"]) ||
      typeof value.options.format !== "string" ||
      !NUMBER_FORMATS.has(value.options.format)
    )
      return null;
    return {
      ...base,
      type: "number",
      options: {
        format: value.options.format as
          | "integer"
          | "decimal"
          | "percent"
          | "won",
      },
    };
  }
  if (value.type === "select" || value.type === "multi_select") {
    if (
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value.options, ["choices"])
    )
      return null;
    const choices = parseChoices(value.options.choices);
    if (!choices) return null;
    return { ...base, type: value.type, options: { choices } };
  }
  if (value.type === "relation") {
    if (
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value.options, [
        "databaseId",
        "direction",
        "mirroredPropertyId",
      ]) ||
      typeof value.options.databaseId !== "string" ||
      !isDatabaseEntityId(value.options.databaseId)
    )
      return null;
    if (
      value.options.direction !== undefined &&
      (typeof value.options.direction !== "string" ||
        !RELATION_DIRECTIONS.has(value.options.direction))
    )
      return null;
    if (
      value.options.mirroredPropertyId !== undefined &&
      (typeof value.options.mirroredPropertyId !== "string" ||
        !isDatabasePropertyId(value.options.mirroredPropertyId))
    )
      return null;
    return {
      ...base,
      type: "relation",
      options: {
        databaseId: value.options.databaseId,
        direction:
          value.options.direction === "mirror" ? "mirror" : "authoritative",
        ...(typeof value.options.mirroredPropertyId === "string"
          ? { mirroredPropertyId: value.options.mirroredPropertyId }
          : {}),
      },
    };
  }
  if (value.type === "formula") {
    if (
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value.options, ["expression", "resultType"]) ||
      typeof value.options.expression !== "string" ||
      (value.options.resultType !== undefined &&
        (typeof value.options.resultType !== "string" ||
          !COMPUTED_RESULT_TYPES.has(value.options.resultType)))
    )
      return null;
    return {
      ...base,
      type: "formula",
      options: {
        expression: value.options.expression,
        ...(typeof value.options.resultType === "string"
          ? {
              resultType: value.options
                .resultType as DatabaseComputedResultType,
            }
          : {}),
      },
    };
  }
  if (value.type === "rollup") {
    if (
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value.options, [
        "relationPropertyId",
        "targetPropertyId",
        "calculation",
        "resultType",
      ])
    )
      return null;
    const { relationPropertyId, targetPropertyId, calculation } = value.options;
    if (
      typeof relationPropertyId !== "string" ||
      !isDatabasePropertyId(relationPropertyId)
    )
      return null;
    if (
      typeof targetPropertyId !== "string" ||
      !isDatabasePropertyId(targetPropertyId)
    )
      return null;
    if (
      typeof calculation !== "string" ||
      !ROLLUP_CALCULATIONS.has(calculation)
    )
      return null;
    if (
      value.options.resultType !== undefined &&
      (typeof value.options.resultType !== "string" ||
        !COMPUTED_RESULT_TYPES.has(value.options.resultType))
    )
      return null;
    return {
      ...base,
      type: "rollup",
      options: {
        relationPropertyId,
        targetPropertyId,
        calculation: calculation as
          | "count"
          | "sum"
          | "avg"
          | "min"
          | "max"
          | "show",
        ...(typeof value.options.resultType === "string"
          ? {
              resultType: value.options
                .resultType as DatabaseComputedResultType,
            }
          : {}),
      },
    };
  }
  if (value.type === "status") {
    if (
      !hasOnlyObjectKeys(value, ["id", "name", "type", "options"]) ||
      !isRecord(value.options) ||
      !hasOnlyObjectKeys(value.options, ["choices"]) ||
      !Array.isArray(value.options.choices)
    )
      return null;
    const choices: DatabaseStatusChoice[] = [];
    const ids = new Set<string>();
    for (const raw of value.options.choices) {
      const choice =
        isRecord(raw) &&
        hasOnlyObjectKeys(raw, ["id", "name", "color", "group"])
          ? parseChoice({
              id: raw.id,
              name: raw.name,
              ...(raw.color !== undefined ? { color: raw.color } : {}),
            })
          : null;
      if (
        !choice ||
        !isRecord(raw) ||
        typeof raw.group !== "string" ||
        !STATUS_GROUPS.has(raw.group) ||
        ids.has(choice.id)
      )
        return null;
      ids.add(choice.id);
      choices.push({
        ...choice,
        group: raw.group as "todo" | "doing" | "done",
      });
    }
    return { ...base, type: "status", options: { choices } };
  }
  if (!hasOnlyObjectKeys(value, ["id", "name", "type"])) return null;
  return { ...base, type: value.type as SimplePropertyType };
}

/** Copies a property's active type and options without its identity/history. */
export function databasePropertyDefinition(
  property: DatabaseProperty,
): DatabasePropertyDefinition {
  const {
    id: _id,
    name: _name,
    priorDefinitions: _prior,
    ...definition
  } = property;
  return definition;
}

function parseProperty(value: unknown): DatabaseProperty | null {
  if (!isRecord(value)) return null;
  const activeValue = { ...value };
  delete activeValue.priorDefinitions;
  const active = parseActiveProperty(activeValue);
  if (!active) return null;
  if (value.priorDefinitions === undefined) return active;
  if (
    !Array.isArray(value.priorDefinitions) ||
    value.priorDefinitions.length >= DATABASE_PROPERTY_TYPES.length
  ) {
    return null;
  }
  const priorDefinitions: DatabasePropertyDefinition[] = [];
  const seen = new Set<DatabasePropertyType>();
  for (const raw of value.priorDefinitions) {
    if (!isRecord(raw) || !hasOnlyObjectKeys(raw, ["type", "options"])) {
      return null;
    }
    const parsed = parseActiveProperty({
      id: active.id,
      name: active.name,
      ...raw,
    });
    if (!parsed || parsed.type === active.type || seen.has(parsed.type)) {
      return null;
    }
    seen.add(parsed.type);
    priorDefinitions.push(databasePropertyDefinition(parsed));
  }
  return { ...active, priorDefinitions };
}

function parseFilter(value: unknown, depth = 0): DatabaseFilter | null {
  if (!isRecord(value) || depth > MAX_FILTER_DEPTH) return null;
  if (value.kind === "group") {
    if (
      !hasOnlyObjectKeys(value, ["kind", "operator", "filters"]) ||
      (value.operator !== "and" && value.operator !== "or") ||
      !Array.isArray(value.filters) ||
      value.filters.length > MAX_FILTERS_PER_GROUP
    )
      return null;
    const filters: DatabaseFilter[] = [];
    for (const raw of value.filters) {
      const filter = parseFilter(raw, depth + 1);
      if (!filter) return null;
      filters.push(filter);
    }
    return { kind: "group", operator: value.operator, filters };
  }
  if (
    !hasOnlyObjectKeys(value, ["kind", "propertyId", "operator", "value"]) ||
    value.kind !== "rule" ||
    typeof value.propertyId !== "string" ||
    !isDatabasePropertyId(value.propertyId)
  )
    return null;
  if (
    typeof value.operator !== "string" ||
    !FILTER_OPERATORS.has(value.operator)
  )
    return null;
  const rule: DatabaseFilterRule = {
    kind: "rule",
    propertyId: value.propertyId,
    operator: value.operator as DatabaseFilterOperator,
  };
  if (Object.hasOwn(value, "value")) {
    const parsedValue = parseDatabaseCellValue(value.value);
    if (parsedValue === undefined) return null;
    rule.value = parsedValue;
  }
  return rule;
}

function parseSort(value: unknown): DatabaseSort | null {
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, ["propertyId", "direction"]) ||
    typeof value.propertyId !== "string" ||
    !isDatabasePropertyId(value.propertyId)
  )
    return null;
  if (
    typeof value.direction !== "string" ||
    !SORT_DIRECTIONS.has(value.direction)
  )
    return null;
  return {
    propertyId: value.propertyId,
    direction: value.direction as "ascending" | "descending",
  };
}

function parseView(
  value: unknown,
  propertyIds: Set<string>,
): DatabaseView | null {
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, [
      "id",
      "name",
      "type",
      "filter",
      "sorts",
      "group",
      "visiblePropertyIds",
      "propertyWidths",
    ]) ||
    typeof value.id !== "string" ||
    !isDatabasePropertyId(value.id)
  )
    return null;
  if (
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !VIEW_TYPES.has(value.type)
  )
    return null;
  if (!Array.isArray(value.sorts) || !Array.isArray(value.visiblePropertyIds))
    return null;
  const sorts: DatabaseSort[] = [];
  for (const raw of value.sorts) {
    const sort = parseSort(raw);
    if (!sort || !propertyIds.has(sort.propertyId)) return null;
    sorts.push(sort);
  }
  const visiblePropertyIds: string[] = [];
  const visibleIds = new Set<string>();
  for (const raw of value.visiblePropertyIds) {
    if (typeof raw !== "string" || !propertyIds.has(raw) || visibleIds.has(raw))
      return null;
    visibleIds.add(raw);
    visiblePropertyIds.push(raw);
  }
  const view: DatabaseView = {
    id: value.id,
    name: value.name,
    type: value.type as DatabaseView["type"],
    sorts,
    visiblePropertyIds,
  };
  if (value.filter !== undefined) {
    const filter = parseFilter(value.filter);
    if (!filter) return null;
    view.filter = filter;
  }
  if (value.group !== undefined) {
    const group = parseSort(value.group);
    if (!group) return null;
    view.group = group;
  }
  if (value.propertyWidths !== undefined) {
    if (!isRecord(value.propertyWidths)) return null;
    const entries: Array<[string, number]> = [];
    for (const [propertyId, width] of Object.entries(value.propertyWidths)) {
      if (
        !propertyIds.has(propertyId) ||
        typeof width !== "number" ||
        !Number.isFinite(width) ||
        width <= 0
      )
        return null;
      entries.push([propertyId, width]);
    }
    view.propertyWidths = Object.fromEntries(entries);
  }
  return view;
}

/** Validates and normalizes a decoded database-schema JSON body. */
export function parseDatabaseSchemaContent(
  value: unknown,
): DatabaseSchemaContent | null {
  if (
    !isRecord(value) ||
    !hasOnlyObjectKeys(value, [
      "name",
      "icon",
      "properties",
      "views",
      "createdAt",
      "updatedAt",
      "deleted",
    ]) ||
    typeof value.name !== "string"
  )
    return null;
  if (!Array.isArray(value.properties) || !Array.isArray(value.views))
    return null;
  if (
    !isFiniteNonNegativeNumber(value.createdAt) ||
    !isFiniteNonNegativeNumber(value.updatedAt)
  )
    return null;
  if (value.icon !== undefined && typeof value.icon !== "string") return null;
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") {
    return null;
  }
  const properties: DatabaseProperty[] = [];
  const propertyIds = new Set<string>();
  let titleCount = 0;
  for (const raw of value.properties) {
    const property = parseProperty(raw);
    if (!property || propertyIds.has(property.id)) return null;
    propertyIds.add(property.id);
    if (property.type === "title") titleCount += 1;
    properties.push(property);
  }
  if (titleCount !== 1) return null;
  const views: DatabaseView[] = [];
  const viewIds = new Set<string>();
  for (const raw of value.views) {
    const view = parseView(raw, propertyIds);
    if (!view || viewIds.has(view.id)) return null;
    viewIds.add(view.id);
    views.push(view);
  }
  return {
    name: value.name,
    ...(typeof value.icon === "string" && value.icon.length > 0
      ? { icon: value.icon }
      : {}),
    properties,
    views,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.deleted === true ? { deleted: true } : {}),
  };
}

/** Fixed top-level key order for stable event-content bytes. */
export function serializeDatabaseSchemaContent(
  content: DatabaseSchemaContent,
): string {
  return JSON.stringify({
    name: content.name,
    ...(content.icon ? { icon: content.icon } : {}),
    properties: content.properties,
    views: content.views,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    ...(content.deleted === true ? { deleted: true } : {}),
  });
}

export function databaseSchemaDTag(id: string): string {
  return `${COMMUNITY_DATABASE_SCHEMA_D_PREFIX}${id}`;
}

export function databaseSchemaIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(COMMUNITY_DATABASE_SCHEMA_D_PREFIX)) return null;
  const id = dTag.slice(COMMUNITY_DATABASE_SCHEMA_D_PREFIX.length);
  return isDatabaseEntityId(id) ? id : null;
}

export function newDatabaseId(): string {
  return crypto.randomUUID();
}

/** Builds an unsigned schema event for the dedicated kind by default. */
export function buildDatabaseSchemaEventInput(
  schema: DatabaseSchemaContent & { id: string },
  kind:
    | typeof KIND_COMMUNITY_DATABASE_SCHEMA
    | typeof KIND_COMMUNITY_DATABASE_LEGACY = KIND_COMMUNITY_DATABASE_SCHEMA,
): { kind: number; content: string; tags: string[][] } {
  if (
    kind !== KIND_COMMUNITY_DATABASE_SCHEMA &&
    kind !== KIND_COMMUNITY_DATABASE_LEGACY
  ) {
    throw new Error("Invalid database schema event kind.");
  }
  if (!isDatabaseEntityId(schema.id)) {
    throw new Error("Invalid database id for schema event.");
  }
  const { id, ...rawContent } = schema;
  const content = parseDatabaseSchemaContent(rawContent);
  if (!content) {
    throw new Error("Invalid database schema content.");
  }
  return {
    kind,
    content: serializeDatabaseSchemaContent(content),
    tags: [
      ["d", databaseSchemaDTag(id)],
      ["t", COMMUNITY_DATABASE_SCHEMA_TAG],
    ],
  };
}

/** UTF-8 size of the schema event content that would be signed. */
export function measureDatabaseSchemaContentBytes(
  schema: DatabaseSchemaContent & { id: string },
): number {
  return new TextEncoder().encode(buildDatabaseSchemaEventInput(schema).content)
    .length;
}

/** Decodes one dedicated or tagged legacy schema event. */
export function parseDatabaseSchemaEvent(
  event: RelayEvent,
): DatabaseSchema | null {
  if (
    event.kind !== KIND_COMMUNITY_DATABASE_SCHEMA &&
    event.kind !== KIND_COMMUNITY_DATABASE_LEGACY
  )
    return null;
  const dTag = singleTagValue(event.tags, "d");
  if (dTag === null || !hasTag(event.tags, "t", COMMUNITY_DATABASE_SCHEMA_TAG))
    return null;
  const id = databaseSchemaIdFromDTag(dTag);
  if (id === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  const content = parseDatabaseSchemaContent(raw);
  if (!content) return null;
  return {
    id,
    author: event.pubkey,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    eventKind: event.kind,
    name: content.name,
    ...(content.icon ? { icon: content.icon } : {}),
    properties: content.properties,
    views: content.views,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    deleted: content.deleted === true,
  };
}

/** Resolves community-wide schema versions across authors with NIP-01 LWW. */
export function pickLatestDatabaseSchemas(
  schemas: Iterable<DatabaseSchema>,
): Map<string, DatabaseSchema> {
  const latest = new Map<string, DatabaseSchema>();
  for (const schema of schemas) {
    const current = latest.get(schema.id);
    if (!current || compareRelayVersions(schema, current) > 0) {
      latest.set(schema.id, schema);
    }
  }
  return latest;
}
