import { Plus } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  changeDatabaseViewType,
  createDatabaseView,
  renameDatabaseView,
} from "../lib/databaseViewCommands";
import type { DatabaseSchema, DatabaseView } from "../lib/databaseSchemaCodec";
import type { DatabaseSchemaMutation } from "./DatabaseViewSettings";

function newViewId(): string {
  return `view_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Saved-view tabs and friendly create/name/type controls. */
export function DatabaseViewTabs({
  disabled,
  onChange,
  onSelect,
  schema,
  selectedViewId,
}: {
  disabled: boolean;
  onChange: (mutation: DatabaseSchemaMutation, selectAfter?: string) => void;
  onSelect: (viewId: string) => void;
  schema: DatabaseSchema;
  selectedViewId: string;
}) {
  const selected =
    schema.views.find((view) => view.id === selectedViewId) ?? schema.views[0];
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<DatabaseView["type"]>("table");
  if (!selected) return null;
  const create = () => {
    const id = newViewId();
    onChange(
      (latest) =>
        createDatabaseView(latest, {
          id,
          name: name.trim() || "Untitled view",
          type,
        }),
      id,
    );
    setName("");
    setCreating(false);
  };
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div
        aria-label="Database views"
        className="flex min-w-0 gap-1 overflow-x-auto"
        role="tablist"
      >
        {schema.views.map((view) => (
          <button
            aria-selected={view.id === selected.id}
            className="min-h-8 shrink-0 rounded-md px-2.5 text-xs hover:bg-muted aria-[selected=true]:bg-muted aria-[selected=true]:font-medium"
            key={view.id}
            onClick={() => onSelect(view.id)}
            role="tab"
            type="button"
          >
            {view.name}
          </button>
        ))}
      </div>
      <Button
        aria-label="New view"
        disabled={disabled}
        onClick={() => setCreating((value) => !value)}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Plus />
      </Button>
      <Input
        aria-label="View name"
        className="h-8 w-36 text-xs"
        defaultValue={selected.name}
        disabled={disabled}
        key={`${selected.id}:${selected.name}`}
        onBlur={(event) => {
          if (event.target.value.trim() !== selected.name) {
            const nextName = event.target.value;
            onChange((latest) =>
              renameDatabaseView(latest, selected.id, nextName),
            );
          }
        }}
      />
      <select
        aria-label="View type"
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        disabled={disabled}
        onChange={(event) =>
          onChange((latest) =>
            changeDatabaseViewType(
              latest,
              selected.id,
              event.target.value as DatabaseView["type"],
            ),
          )
        }
        value={selected.type}
      >
        <option value="table">Table</option>
        <option value="board">Board</option>
        <option value="calendar">Calendar</option>
        <option value="gallery">Gallery</option>
      </select>
      {creating ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background p-2">
          <Input
            aria-label="New view name"
            className="h-8 w-36 text-xs"
            onChange={(event) => setName(event.target.value)}
            placeholder="View name"
            value={name}
          />
          <select
            aria-label="New view type"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            onChange={(event) =>
              setType(event.target.value as DatabaseView["type"])
            }
            value={type}
          >
            <option value="table">Table</option>
            <option value="board">Board</option>
            <option value="calendar">Calendar</option>
            <option value="gallery">Gallery</option>
          </select>
          <Button
            disabled={!name.trim()}
            onClick={create}
            size="sm"
            type="button"
          >
            Create view
          </Button>
          <Button
            onClick={() => setCreating(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
