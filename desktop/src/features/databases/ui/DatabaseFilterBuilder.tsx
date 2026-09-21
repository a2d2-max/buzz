import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import type {
  DatabaseFilter,
  DatabaseFilterGroup,
  DatabaseFilterOperator,
  DatabaseFilterRule,
  DatabaseProperty,
} from "../lib/databaseSchemaCodec";
import type { DatabaseCellValue } from "../lib/databaseValue";
import {
  isDatabaseDateOnly,
  isDatabaseTimedInstant,
} from "../lib/databaseDateValue";
import {
  databaseComputedResultIsList,
  databaseComputedScalarType,
  databasePropertyComputedResultType,
  type DatabaseComputedScalarType,
} from "../lib/databaseComputedType";

const EMPTY_OR_CHECKED = new Set([
  "is_empty",
  "is_not_empty",
  "is_checked",
  "is_not_checked",
]);

function isAutomaticTime(property: DatabaseProperty): boolean {
  return (
    property.type === "created_time" || property.type === "last_edited_time"
  );
}

function defaultFilterValue(property: DatabaseProperty): DatabaseCellValue {
  const kind = filterValueKind(property);
  if (kind === "number") return 0;
  if (kind === "boolean") return true;
  if (kind === "date") {
    const start = new Date().toISOString().slice(0, 10);
    return computedIsList(property) ? { start, includeTime: false } : start;
  }
  if (isAutomaticTime(property)) return Date.now();
  if (
    property.type === "multi_select" ||
    property.type === "person" ||
    property.type === "relation"
  )
    return [];
  return "";
}

function computedScalarType(
  property: DatabaseProperty,
): DatabaseComputedScalarType | "unknown" {
  return property.type === "formula" || property.type === "rollup"
    ? databaseComputedScalarType(databasePropertyComputedResultType(property))
    : "unknown";
}

function computedIsList(property: DatabaseProperty): boolean {
  return (
    (property.type === "formula" || property.type === "rollup") &&
    databaseComputedResultIsList(databasePropertyComputedResultType(property))
  );
}

function filterValueKind(
  property: DatabaseProperty,
): DatabaseComputedScalarType | "unknown" {
  if (property.type === "number" || isAutomaticTime(property)) return "number";
  if (property.type === "checkbox") return "boolean";
  if (property.type === "date") return "date";
  if (property.type === "formula" || property.type === "rollup") {
    return computedScalarType(property);
  }
  return "text";
}

function isMembershipProperty(property: DatabaseProperty): boolean {
  return (
    property.type === "multi_select" ||
    property.type === "person" ||
    property.type === "relation" ||
    computedIsList(property)
  );
}

function isMembershipOperator(operator: DatabaseFilterOperator): boolean {
  return operator === "contains" || operator === "not_contains";
}

function operatorsFor(property: DatabaseProperty) {
  switch (property.type) {
    case "number":
    case "created_time":
    case "last_edited_time":
      return [
        "equals",
        "not_equals",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
        "is_empty",
        "is_not_empty",
      ] as const;
    case "date":
      return [
        "equals",
        "not_equals",
        "before",
        "after",
        "on_or_before",
        "on_or_after",
        "between",
        "is_empty",
        "is_not_empty",
      ] as const;
    case "formula":
    case "rollup": {
      const resultType = databasePropertyComputedResultType(property);
      if (databaseComputedResultIsList(resultType)) {
        return [
          "contains",
          "not_contains",
          "is_empty",
          "is_not_empty",
        ] as const;
      }
      switch (databaseComputedScalarType(resultType)) {
        case "number":
          return [
            "equals",
            "not_equals",
            "greater_than",
            "greater_than_or_equal",
            "less_than",
            "less_than_or_equal",
            "is_empty",
            "is_not_empty",
          ] as const;
        case "boolean":
          return ["equals", "not_equals", "is_empty", "is_not_empty"] as const;
        case "date":
          return [
            "equals",
            "not_equals",
            "before",
            "after",
            "on_or_before",
            "on_or_after",
            "between",
            "is_empty",
            "is_not_empty",
          ] as const;
        default:
          return [
            "equals",
            "not_equals",
            "contains",
            "not_contains",
            "is_empty",
            "is_not_empty",
          ] as const;
      }
    }
    case "checkbox":
      return [
        "is_checked",
        "is_not_checked",
        "is_empty",
        "is_not_empty",
      ] as const;
    default:
      return [
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "is_empty",
        "is_not_empty",
      ] as const;
  }
}

function defaultRule(properties: DatabaseProperty[]): DatabaseFilterRule {
  const property = properties[0];
  const operator = property
    ? (operatorsFor(property)[0] as DatabaseFilterOperator)
    : "contains";
  return {
    kind: "rule",
    propertyId: property?.id ?? "missing",
    operator,
    ...(property && !EMPTY_OR_CHECKED.has(operator)
      ? { value: defaultFilterValue(property) }
      : {}),
  };
}

function normalizeRuleProperty(property: DatabaseProperty): DatabaseFilterRule {
  const operator = operatorsFor(property)[0] as DatabaseFilterOperator;
  return {
    kind: "rule",
    propertyId: property.id,
    operator,
    ...(EMPTY_OR_CHECKED.has(operator)
      ? {}
      : { value: defaultFilterValue(property) }),
  };
}

function inputValue(value: DatabaseCellValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "object" ? value.start : String(value);
}

function automaticTimeInputValue(value: DatabaseCellValue | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(value - offset * 60_000).toISOString().slice(0, 16);
}

function filterUsesTime(value: DatabaseCellValue | undefined): boolean {
  return Array.isArray(value)
    ? value.some(
        (entry) => typeof entry === "string" && isDatabaseTimedInstant(entry),
      )
    : typeof value === "string" && isDatabaseTimedInstant(value);
}

function dateInputValue(
  value: DatabaseCellValue | undefined,
  includeTime: boolean,
): string {
  if (typeof value !== "string") return "";
  if (!includeTime) return isDatabaseDateOnly(value) ? value : "";
  if (!isDatabaseTimedInstant(value)) return "";
  return automaticTimeInputValue(Date.parse(value));
}

function dateValueFromInput(raw: string, includeTime: boolean): string {
  if (!includeTime || raw === "") return raw;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function convertDateFilterValue(value: unknown, includeTime: boolean): string {
  if (typeof value !== "string" || value === "")
    return includeTime ? new Date().toISOString() : "";
  if (includeTime) {
    if (isDatabaseTimedInstant(value)) return value;
    if (!isDatabaseDateOnly(value)) return "";
    return dateValueFromInput(`${value}T00:00`, true);
  }
  if (isDatabaseDateOnly(value)) return value;
  return isDatabaseTimedInstant(value)
    ? automaticTimeInputValue(Date.parse(value)).slice(0, 10)
    : "";
}

function normalizeRuleValue(
  property: DatabaseProperty,
  operator: DatabaseFilterOperator,
  value: DatabaseCellValue | undefined,
): DatabaseCellValue | undefined {
  if (EMPTY_OR_CHECKED.has(operator)) return undefined;
  if (property.type === "number")
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (isAutomaticTime(property))
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : Date.now();
  if (property.type === "formula" || property.type === "rollup") {
    const kind = computedScalarType(property);
    if (kind === "number") {
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
    if (kind === "boolean") return typeof value === "boolean" ? value : true;
    if (kind === "date") {
      if (computedIsList(property)) {
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          "start" in value
        ) {
          return value;
        }
        return {
          start: new Date().toISOString().slice(0, 10),
          includeTime: false,
        };
      }
      if (operator === "between") {
        return Array.isArray(value) ? value : ["", ""];
      }
      return typeof value === "string" ? value : "";
    }
    return typeof value === "string" ? value : "";
  }
  if (property.type === "date") {
    if (operator === "between") {
      if (Array.isArray(value)) {
        return [String(value[0] ?? ""), String(value[1] ?? "")];
      }
      return typeof value === "string" ? [value, value] : ["", ""];
    }
    if (typeof value === "string") return value;
    return Array.isArray(value) ? String(value[0] ?? "") : "";
  }
  if (isMembershipProperty(property)) {
    if (isMembershipOperator(operator)) {
      if (typeof value === "string") return value;
      return Array.isArray(value) ? String(value[0] ?? "") : "";
    }
    if (Array.isArray(value))
      return value.filter(
        (entry): entry is string => typeof entry === "string",
      );
    return typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  }
  return typeof value === "string" ? value : "";
}

function parseValue(
  property: DatabaseProperty,
  operator: DatabaseFilterOperator,
  raw: string,
): DatabaseCellValue {
  if (
    property.type === "number" ||
    ((property.type === "formula" || property.type === "rollup") &&
      computedScalarType(property) === "number")
  )
    return raw === "" ? null : Number(raw);
  if (isAutomaticTime(property)) {
    if (raw === "") return null;
    const timestamp = new Date(raw).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (property.type === "date" && operator === "between") {
    const [start = "", end = ""] = raw.split("|");
    return [start, end];
  }
  if (property.type === "formula" || property.type === "rollup") {
    const kind = computedScalarType(property);
    if (kind === "boolean") return raw === "true";
    if (kind === "date") {
      if (computedIsList(property)) {
        return { start: raw, includeTime: false };
      }
      if (operator === "between") {
        const [start = "", end = ""] = raw.split("|");
        return [start, end];
      }
      return raw;
    }
  }
  if (isMembershipProperty(property)) {
    return isMembershipOperator(operator)
      ? raw
      : raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  }
  return raw;
}

function FilterRuleEditor({
  properties,
  rule,
  onChange,
  onRemove,
}: {
  properties: DatabaseProperty[];
  rule: DatabaseFilterRule;
  onChange: (rule: DatabaseFilterRule) => void;
  onRemove: () => void;
}) {
  const storedProperty = properties.find(
    (candidate) => candidate.id === rule.propertyId,
  );
  const property = storedProperty ?? properties[0];
  if (!property) return null;
  const operators = operatorsFor(property);
  const needsValue = !EMPTY_OR_CHECKED.has(rule.operator);
  const choiceProperty =
    property.type === "select" || property.type === "status" ? property : null;
  const computedKind = computedScalarType(property);
  const computedList = computedIsList(property);
  const booleanProperty =
    (property.type === "formula" || property.type === "rollup") &&
    computedKind === "boolean" &&
    !computedList;
  const dateProperty =
    property.type === "date" ||
    ((property.type === "formula" || property.type === "rollup") &&
      computedKind === "date" &&
      !computedList);
  const dateListProperty =
    (property.type === "formula" || property.type === "rollup") &&
    computedKind === "date" &&
    computedList;
  const dateIncludesTime = dateProperty && filterUsesTime(rule.value);
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 p-2">
      <select
        aria-label="Filter property"
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        onChange={(event) => {
          const next = properties.find(({ id }) => id === event.target.value);
          if (next) onChange(normalizeRuleProperty(next));
        }}
        value={rule.propertyId}
      >
        {!storedProperty ? (
          <option value={rule.propertyId}>
            Missing property ({rule.propertyId})
          </option>
        ) : null}
        {properties.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter operator"
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        onChange={(event) => {
          const operator = event.target.value as DatabaseFilterOperator;
          onChange({
            ...rule,
            operator,
            value: normalizeRuleValue(property, operator, rule.value),
          });
        }}
        value={rule.operator}
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {operator.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      {needsValue ? (
        choiceProperty ? (
          <select
            aria-label="Filter value"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            onChange={(event) =>
              onChange({ ...rule, value: event.target.value })
            }
            value={typeof rule.value === "string" ? rule.value : ""}
          >
            <option value="">Choose…</option>
            {choiceProperty.options.choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
          </select>
        ) : booleanProperty ? (
          <select
            aria-label="Filter value"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            onChange={(event) =>
              onChange({ ...rule, value: event.target.value === "true" })
            }
            value={rule.value === false ? "false" : "true"}
          >
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        ) : dateListProperty ? (
          <Input
            aria-label="Filter value"
            className="h-8 w-36 text-xs"
            onChange={(event) =>
              onChange({
                ...rule,
                value: { start: event.target.value, includeTime: false },
              })
            }
            type="date"
            value={
              typeof rule.value === "object" &&
              rule.value !== null &&
              !Array.isArray(rule.value) &&
              "start" in rule.value
                ? rule.value.start
                : ""
            }
          />
        ) : dateProperty ? (
          <span className="flex flex-wrap items-center gap-1">
            {rule.operator === "between" ? (
              <>
                <Input
                  aria-label="Filter value start"
                  className="h-8 w-36 text-xs"
                  onChange={(event) => {
                    const current = Array.isArray(rule.value)
                      ? rule.value
                      : ["", ""];
                    onChange({
                      ...rule,
                      value: [
                        dateValueFromInput(
                          event.target.value,
                          dateIncludesTime,
                        ),
                        String(current[1] ?? ""),
                      ],
                    });
                  }}
                  type={dateIncludesTime ? "datetime-local" : "date"}
                  value={
                    Array.isArray(rule.value)
                      ? dateInputValue(
                          typeof rule.value[0] === "string"
                            ? rule.value[0]
                            : undefined,
                          dateIncludesTime,
                        )
                      : ""
                  }
                />
                <Input
                  aria-label="Filter value end"
                  className="h-8 w-36 text-xs"
                  onChange={(event) => {
                    const current = Array.isArray(rule.value)
                      ? rule.value
                      : ["", ""];
                    onChange({
                      ...rule,
                      value: [
                        String(current[0] ?? ""),
                        dateValueFromInput(
                          event.target.value,
                          dateIncludesTime,
                        ),
                      ],
                    });
                  }}
                  type={dateIncludesTime ? "datetime-local" : "date"}
                  value={
                    Array.isArray(rule.value)
                      ? dateInputValue(
                          typeof rule.value[1] === "string"
                            ? rule.value[1]
                            : undefined,
                          dateIncludesTime,
                        )
                      : ""
                  }
                />
              </>
            ) : (
              <Input
                aria-label="Filter value"
                className="h-8 w-36 text-xs"
                onChange={(event) =>
                  onChange({
                    ...rule,
                    value: dateValueFromInput(
                      event.target.value,
                      dateIncludesTime,
                    ),
                  })
                }
                type={dateIncludesTime ? "datetime-local" : "date"}
                value={dateInputValue(rule.value, dateIncludesTime)}
              />
            )}
            <label className="flex h-8 items-center gap-1 text-xs">
              <input
                aria-label="Include time in filter"
                checked={dateIncludesTime}
                onChange={(event) => {
                  const includeTime = event.target.checked;
                  onChange({
                    ...rule,
                    value:
                      rule.operator === "between"
                        ? [
                            convertDateFilterValue(
                              Array.isArray(rule.value)
                                ? rule.value[0]
                                : undefined,
                              includeTime,
                            ),
                            convertDateFilterValue(
                              Array.isArray(rule.value)
                                ? rule.value[1]
                                : undefined,
                              includeTime,
                            ),
                          ]
                        : convertDateFilterValue(rule.value, includeTime),
                  });
                }}
                type="checkbox"
              />
              Include time
            </label>
          </span>
        ) : (
          <Input
            aria-label="Filter value"
            className="h-8 min-w-32 flex-1 text-xs"
            onChange={(event) =>
              onChange({
                ...rule,
                value: parseValue(property, rule.operator, event.target.value),
              })
            }
            type={
              property.type === "number"
                ? "number"
                : (property.type === "formula" || property.type === "rollup") &&
                    computedKind === "number"
                  ? "number"
                  : isAutomaticTime(property)
                    ? "datetime-local"
                    : "text"
            }
            value={
              isAutomaticTime(property)
                ? automaticTimeInputValue(rule.value)
                : inputValue(rule.value)
            }
          />
        )
      ) : null}
      <Button
        aria-label="Remove filter"
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function FilterGroupEditor({
  group,
  properties,
  nested = false,
  onChange,
  onRemove,
}: {
  group: DatabaseFilterGroup;
  properties: DatabaseProperty[];
  nested?: boolean;
  onChange: (group: DatabaseFilterGroup) => void;
  onRemove?: () => void;
}) {
  const replace = (index: number, filter: DatabaseFilter) => {
    const filters = [...group.filters];
    filters[index] = filter;
    onChange({ ...group, filters });
  };
  const remove = (index: number) =>
    onChange({
      ...group,
      filters: group.filters.filter((_, at) => at !== index),
    });
  const keyCounts = new Map<string, number>();
  const keyedFilters = group.filters.map((filter, index) => {
    const signature = JSON.stringify(filter);
    const occurrence = keyCounts.get(signature) ?? 0;
    keyCounts.set(signature, occurrence + 1);
    return { filter, index, key: `${signature}:${occurrence}` };
  });
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg ${nested ? "border border-border/60 p-2" : ""}`}
    >
      <div className="flex items-center gap-2">
        <select
          aria-label="Filter logic"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          onChange={(event) =>
            onChange({ ...group, operator: event.target.value as "and" | "or" })
          }
          value={group.operator}
        >
          <option value="and">All (AND)</option>
          <option value="or">Any (OR)</option>
        </select>
        {onRemove ? (
          <Button
            aria-label="Remove filter group"
            onClick={onRemove}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      {keyedFilters.map(({ filter, index, key }) =>
        filter.kind === "group" ? (
          <FilterGroupEditor
            group={filter}
            key={key}
            nested
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
            properties={properties}
          />
        ) : (
          <FilterRuleEditor
            key={key}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
            properties={properties}
            rule={filter}
          />
        ),
      )}
      <div className="flex gap-1">
        <Button
          onClick={() =>
            onChange({
              ...group,
              filters: [...group.filters, defaultRule(properties)],
            })
          }
          size="xs"
          type="button"
          variant="outline"
        >
          <Plus /> Add rule
        </Button>
        <Button
          aria-label="Add filter group"
          onClick={() =>
            onChange({
              ...group,
              filters: [
                ...group.filters,
                {
                  kind: "group",
                  operator: "and",
                  filters: [defaultRule(properties)],
                },
              ],
            })
          }
          size="xs"
          type="button"
          variant="outline"
        >
          <Plus /> Add group
        </Button>
      </div>
    </div>
  );
}

/** Friendly recursive AND/OR editor for the saved filter wire type. */
export function DatabaseFilterBuilder({
  filter,
  onChange,
  properties,
}: {
  filter: DatabaseFilterGroup | null;
  onChange: (filter: DatabaseFilterGroup | null) => void;
  properties: DatabaseProperty[];
}) {
  if (!filter) {
    return (
      <Button
        onClick={() =>
          onChange({
            kind: "group",
            operator: "and",
            filters: [defaultRule(properties)],
          })
        }
        size="xs"
        type="button"
        variant="outline"
      >
        <Plus /> Add filter
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <FilterGroupEditor
        group={filter}
        onChange={onChange}
        properties={properties}
      />
      <Button
        onClick={() => onChange(null)}
        size="xs"
        type="button"
        variant="ghost"
      >
        Clear filters
      </Button>
    </div>
  );
}
