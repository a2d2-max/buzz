import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type {
  DatabaseProperty,
  DatabaseSort,
} from "../lib/databaseSchemaCodec";

/** Friendly ordered multi-sort editor. */
export function DatabaseSortBuilder({
  onChange,
  properties,
  sorts,
}: {
  onChange: (sorts: DatabaseSort[]) => void;
  properties: DatabaseProperty[];
  sorts: DatabaseSort[];
}) {
  const replace = (index: number, sort: DatabaseSort) => {
    const next = [...sorts];
    next[index] = sort;
    onChange(next);
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= sorts.length) return;
    const next = [...sorts];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {sorts.map((sort, index) => (
        <div className="flex items-center gap-1.5" key={sort.propertyId}>
          <select
            aria-label="Sort property"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            onChange={(event) =>
              replace(index, { ...sort, propertyId: event.target.value })
            }
            value={sort.propertyId}
          >
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort direction"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            onChange={(event) =>
              replace(index, {
                ...sort,
                direction: event.target.value as DatabaseSort["direction"],
              })
            }
            value={sort.direction}
          >
            <option value="ascending">Ascending</option>
            <option value="descending">Descending</option>
          </select>
          <Button
            aria-label="Move sort up"
            disabled={index === 0}
            onClick={() => move(index, -1)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ArrowUp />
          </Button>
          <Button
            aria-label="Move sort down"
            disabled={index === sorts.length - 1}
            onClick={() => move(index, 1)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <ArrowDown />
          </Button>
          <Button
            aria-label="Remove sort"
            onClick={() => onChange(sorts.filter((_, at) => at !== index))}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        disabled={sorts.length >= properties.length}
        onClick={() => {
          const used = new Set(sorts.map(({ propertyId }) => propertyId));
          const property = properties.find(({ id }) => !used.has(id));
          if (property)
            onChange([
              ...sorts,
              { propertyId: property.id, direction: "ascending" },
            ]);
        }}
        size="xs"
        type="button"
        variant="outline"
      >
        <Plus /> Add sort
      </Button>
    </div>
  );
}
