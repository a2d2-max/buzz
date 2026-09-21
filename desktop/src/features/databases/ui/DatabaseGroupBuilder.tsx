import type {
  DatabaseGroup,
  DatabaseProperty,
  DatabaseView,
} from "../lib/databaseSchemaCodec";

function compatible(
  property: DatabaseProperty,
  viewType: DatabaseView["type"],
) {
  if (viewType === "board")
    return ["select", "status", "person"].includes(property.type);
  if (viewType === "calendar") return property.type === "date";
  return true;
}

/** Type-aware saved grouping editor. */
export function DatabaseGroupBuilder({
  group,
  onChange,
  properties,
  viewType,
}: {
  group: DatabaseGroup | null;
  onChange: (group: DatabaseGroup | null) => void;
  properties: DatabaseProperty[];
  viewType: DatabaseView["type"];
}) {
  const available = properties.filter((property) =>
    compatible(property, viewType),
  );
  const missingGroup =
    group && !properties.some((property) => property.id === group.propertyId)
      ? group
      : null;
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={
          viewType === "calendar" ? "Date property" : "Group property"
        }
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        onChange={(event) =>
          onChange(
            event.target.value
              ? {
                  propertyId: event.target.value,
                  direction: group?.direction ?? "ascending",
                }
              : null,
          )
        }
        value={group?.propertyId ?? ""}
      >
        <option value="">No grouping</option>
        {missingGroup ? (
          <option value={missingGroup.propertyId}>
            Missing property ({missingGroup.propertyId})
          </option>
        ) : null}
        {available.map((property) => (
          <option key={property.id} value={property.id}>
            {property.name}
          </option>
        ))}
      </select>
      {viewType !== "calendar" && group ? (
        <select
          aria-label="Group direction"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          onChange={(event) =>
            onChange({
              ...group,
              direction: event.target.value as DatabaseGroup["direction"],
            })
          }
          value={group.direction}
        >
          <option value="ascending">Ascending</option>
          <option value="descending">Descending</option>
        </select>
      ) : null}
    </div>
  );
}
