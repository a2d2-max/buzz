import {
  databaseCellValueMatches,
  databaseCellPresentation,
} from "../lib/databaseCellModel";
import {
  databaseComputedValueText,
  isDatabaseComputedError,
} from "../lib/databaseComputedValue";
import type { DatabaseProperty } from "../lib/databaseSchemaCodec";
import type { DatabaseCellValue } from "../lib/databaseValue";
import type {
  DatabaseRowGroup,
  ResolvedDatabaseRow,
} from "../lib/databaseViewEngine";

function resolvedText(
  property: DatabaseProperty,
  resolved: ResolvedDatabaseRow,
): string {
  const value = resolved.values.get(property.id);
  if (isDatabaseComputedError(value)) return databaseComputedValueText(value);
  if (value === undefined) return "";
  if (value === null) return property.type === "created_by" ? "Unknown" : "";
  if (
    (property.type === "select" || property.type === "status") &&
    typeof value === "string"
  ) {
    return (
      property.options.choices.find((choice) => choice.id === value)?.name ??
      `Unknown option (${value})`
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
  if (typeof value === "object") {
    if (Array.isArray(value))
      return value.map(databaseComputedValueText).join(", ");
    return value.end ? `${value.start} – ${value.end}` : value.start;
  }
  return String(value);
}

function GalleryCard({
  properties,
  resolved,
  titleProperty,
}: {
  properties: DatabaseProperty[];
  resolved: ResolvedDatabaseRow;
  titleProperty: DatabaseProperty;
}) {
  const titleValue = resolved.values.get(titleProperty.id);
  const title =
    typeof titleValue === "string"
      ? titleValue.trim() || "Untitled"
      : databaseCellPresentation(titleProperty, resolved.row).text.trim() ||
        "Untitled";
  return (
    <article
      aria-label={title}
      className="flex min-h-32 flex-col gap-3 rounded-xl border border-border/60 bg-background p-4 shadow-xs"
    >
      <h3 className="line-clamp-2 text-sm font-semibold">{title}</h3>
      <dl className="flex flex-col gap-2">
        {properties
          .filter((property) => property.id !== titleProperty.id)
          .slice(0, 5)
          .map((property) => {
            const value = resolved.values.get(property.id);
            const mismatch =
              value !== undefined &&
              !databaseCellValueMatches(property, value as DatabaseCellValue);
            return (
              <div
                className="grid grid-cols-[minmax(0,7rem)_1fr] gap-2 text-xs"
                key={property.id}
              >
                <dt className="truncate text-muted-foreground">
                  {property.name}
                </dt>
                <dd className="min-w-0 truncate">
                  {resolvedText(property, resolved) || "Empty"}
                  {mismatch ? (
                    <span className="ml-1 text-amber-600">Type mismatch</span>
                  ) : null}
                </dd>
              </div>
            );
          })}
      </dl>
    </article>
  );
}

/** Responsive cards over the already filtered, sorted, and grouped rows. */
export function DatabaseGallerySurface({
  groups,
  properties,
  rows,
  titleProperty,
}: {
  groups?: DatabaseRowGroup[];
  properties: DatabaseProperty[];
  rows: ResolvedDatabaseRow[];
  titleProperty: DatabaseProperty;
}) {
  const sections = groups?.length
    ? groups
    : [{ key: "all", label: "All", value: null, rows, empty: false }];
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-4"
      data-testid="database-gallery-surface"
    >
      {sections.map((group) => (
        <section
          aria-label={`${group.label} group`}
          className="mb-5"
          key={group.key}
        >
          {groups?.length ? (
            <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
              {group.label} · {group.rows.length}
            </h2>
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
            {group.rows.map((resolved) => (
              <GalleryCard
                key={`${group.key}:${resolved.row.id}`}
                properties={properties}
                resolved={resolved}
                titleProperty={titleProperty}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
