import { SlidersHorizontal } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";

import {
  setDatabaseViewFilter,
  setDatabaseViewGroup,
  setDatabaseViewSorts,
} from "../lib/databaseViewCommands";
import type {
  DatabaseFilterGroup,
  DatabaseGroup,
  DatabaseSchema,
  DatabaseSort,
  DatabaseView,
} from "../lib/databaseSchemaCodec";
import { DatabaseFilterBuilder } from "./DatabaseFilterBuilder";
import { DatabaseGroupBuilder } from "./DatabaseGroupBuilder";
import { DatabaseSortBuilder } from "./DatabaseSortBuilder";

export type DatabaseSchemaMutation = (schema: DatabaseSchema) => DatabaseSchema;

function filterGroup(view: DatabaseView): DatabaseFilterGroup | null {
  if (!view.filter) return null;
  return view.filter.kind === "group"
    ? structuredClone(view.filter)
    : {
        kind: "group",
        operator: "and",
        filters: [structuredClone(view.filter)],
      };
}

/** Local-draft editor for friendly filter, sort, and group settings. */
export function DatabaseViewSettings({
  disabled,
  onApply,
  schema,
  view,
}: {
  disabled: boolean;
  onApply: (mutation: DatabaseSchemaMutation) => void;
  schema: DatabaseSchema;
  view: DatabaseView;
}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<DatabaseFilterGroup | null>(() =>
    filterGroup(view),
  );
  const [sorts, setSorts] = React.useState<DatabaseSort[]>(() => [
    ...view.sorts,
  ]);
  const [group, setGroup] = React.useState<DatabaseGroup | null>(
    view.group ?? null,
  );
  const [draftViewId, setDraftViewId] = React.useState(view.id);
  const currentViewRef = React.useRef(view);
  currentViewRef.current = view;
  const selectedViewId = view.id;

  React.useEffect(() => {
    const selected = currentViewRef.current;
    setOpen(false);
    setFilter(filterGroup(selected));
    setSorts([...selected.sorts]);
    setGroup(selected.group ?? null);
    setDraftViewId(selectedViewId);
  }, [selectedViewId]);

  const reset = () => {
    const selected = currentViewRef.current;
    setFilter(filterGroup(selected));
    setSorts([...selected.sorts]);
    setGroup(selected.group ?? null);
    setDraftViewId(selected.id);
  };
  const toggle = () => {
    if (!open) reset();
    setOpen((value) => !value);
  };

  return (
    <div className="relative">
      <Button
        aria-expanded={open}
        aria-label="View settings"
        disabled={disabled}
        onClick={toggle}
        size="sm"
        type="button"
        variant="outline"
      >
        <SlidersHorizontal /> View settings
      </Button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 flex max-h-[34rem] w-[min(46rem,calc(100vw-2rem))] flex-col gap-4 overflow-auto rounded-xl border border-border bg-background p-4 shadow-xl">
          <section
            className="flex flex-col gap-2"
            aria-labelledby="database-filter-heading"
          >
            <h3 className="text-xs font-semibold" id="database-filter-heading">
              Filters
            </h3>
            <DatabaseFilterBuilder
              filter={filter}
              onChange={setFilter}
              properties={schema.properties}
            />
          </section>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="database-sort-heading"
          >
            <h3 className="text-xs font-semibold" id="database-sort-heading">
              Sorts
            </h3>
            <DatabaseSortBuilder
              onChange={setSorts}
              properties={schema.properties}
              sorts={sorts}
            />
          </section>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="database-group-heading"
          >
            <h3 className="text-xs font-semibold" id="database-group-heading">
              {view.type === "calendar" ? "Calendar date" : "Grouping"}
            </h3>
            <DatabaseGroupBuilder
              group={group}
              onChange={setGroup}
              properties={schema.properties}
              viewType={view.type}
            />
          </section>
          <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
            <Button
              onClick={() => {
                reset();
                setOpen(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              aria-label="Apply view settings"
              onClick={() => {
                if (draftViewId !== view.id) {
                  reset();
                  setOpen(false);
                  return;
                }
                const targetViewId = draftViewId;
                onApply((latest) => {
                  let next = setDatabaseViewFilter(
                    latest,
                    targetViewId,
                    filter,
                  );
                  next = setDatabaseViewSorts(next, targetViewId, sorts);
                  return setDatabaseViewGroup(next, targetViewId, group);
                });
                setOpen(false);
              }}
              size="sm"
              type="button"
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
