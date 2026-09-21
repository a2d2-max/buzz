import type { DatabaseRow } from "../lib/databaseRowCodec";
import type {
  DatabaseProperty,
  DatabasePropertyType,
} from "../lib/databaseSchemaCodec";
import type { DatabaseCellValue } from "../lib/databaseValue";
import type { DatabaseRowGroup } from "../lib/databaseViewEngine";
import { DatabaseCell } from "./DatabaseCell";
import type { DatabaseRelationCellContext } from "./DatabaseRelationCell";

/** Compact grouped table used when a saved table view has a grouping axis. */
export function DatabaseGroupedTableSurface({
  groups,
  onRestoreType,
  onSaveRowValues,
  properties,
  propertyWidths,
  relationContext,
}: {
  groups: DatabaseRowGroup[];
  onRestoreType: (
    propertyId: string,
    type: DatabasePropertyType,
  ) => Promise<void>;
  onSaveRowValues: (
    rowId: string,
    values: Record<string, DatabaseCellValue>,
    baseEventId: string,
  ) => Promise<DatabaseRow>;
  properties: DatabaseProperty[];
  propertyWidths?: Record<string, number>;
  relationContext?: DatabaseRelationCellContext;
}) {
  const knownPubkeys = [
    ...new Set(
      groups
        .flatMap((group) => group.rows)
        .flatMap(({ row }) => [row.createdBy, row.author])
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return (
    <section
      aria-label="Grouped database table"
      className="min-h-0 flex-1 overflow-auto p-4"
      onKeyDown={(event) => {
        if (!event.key.startsWith("Arrow")) return;
        const target = event.target;
        if (
          !(target instanceof HTMLElement) ||
          target.dataset.databaseCellTrigger !== "true"
        )
          return;
        const triggers = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "[data-database-cell-trigger='true']",
          ),
        ];
        const index = triggers.indexOf(target);
        const offset =
          event.key === "ArrowLeft"
            ? -1
            : event.key === "ArrowRight"
              ? 1
              : event.key === "ArrowUp"
                ? -properties.length
                : properties.length;
        const next = triggers[index + offset];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {groups.map((group) => (
        <section
          aria-label={`${group.label} group`}
          className="mb-4 overflow-hidden rounded-lg border border-border/60"
          key={group.key}
        >
          <div className="flex min-h-9 items-center justify-between bg-muted/50 px-3 text-xs font-semibold">
            <span>{group.label}</span>
            <span className="text-muted-foreground">{group.rows.length}</span>
          </div>
          {group.rows.map((resolved) => (
            <div
              className="flex min-h-12 border-t border-border/50"
              key={resolved.row.id}
            >
              {properties.map((property) => (
                <DatabaseCell
                  key={property.id}
                  knownPubkeys={knownPubkeys}
                  onRestoreType={(type) => onRestoreType(property.id, type)}
                  onSave={(values, baseEventId) =>
                    onSaveRowValues(resolved.row.id, values, baseEventId)
                  }
                  property={property}
                  relationContext={relationContext}
                  resolvedValue={resolved.values.get(property.id)}
                  row={resolved.row}
                  width={propertyWidths?.[property.id] ?? 180}
                />
              ))}
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}
