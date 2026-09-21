import * as React from "react";
import type {
  CommunityTaskFieldDefinition,
  CommunityTaskCustomField,
} from "../lib/communityTaskCustomFields";
import type { useCommunityTaskSchema } from "../lib/useCommunityTaskSchema";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/** Definition creator manages names and archives; everyone can reuse active definitions. */
export function CommunityTaskSchema({
  schema,
  user,
}: {
  schema: ReturnType<typeof useCommunityTaskSchema>;
  user: string | null;
}) {
  const [name, setName] = React.useState("");
  const [type, setType] =
    React.useState<CommunityTaskCustomField["type"]>("text");
  const [editing, setEditing] = React.useState<
    CommunityTaskFieldDefinition | undefined
  >();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const inFlight = React.useRef(false);
  const commit = async (archived: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await schema.save({ name, type, archived }, editing);
      setName("");
      setEditing(undefined);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save shared field.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <details className="shrink-0 border-b border-border px-4 py-2">
      <summary className="cursor-pointer text-sm">Shared fields</summary>
      <p className="my-2 text-xs text-muted-foreground">
        Reuse these fields across tasks. The creator manages each definition.
        Archiving keeps existing values.
      </p>
      {schema.query.data?.map((field) => (
        <div key={field.key} className="flex items-center gap-2 py-1 text-sm">
          <span>
            {field.name} · {field.type}
            {field.archived ? " · Archived" : ""}
          </span>
          {field.owner === user && (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing(field);
                setName(field.name);
                setType(field.type);
              }}
            >
              Edit {field.name}
            </Button>
          )}
        </div>
      ))}
      {user && (
        <div className="my-2 flex flex-wrap gap-2">
          <Input
            aria-label="Shared field name"
            className="w-48"
            maxLength={64}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            aria-label="Shared field type"
            className="rounded-md border border-input bg-background px-2 text-sm"
            disabled={busy || !!editing}
            value={type}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "text" || v === "number" || v === "checkbox")
                setType(v);
            }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="checkbox">Checkbox</option>
          </select>
          <Button
            size="sm"
            disabled={busy || !name.trim() || !schema.query.data}
            onClick={() => void commit(false)}
          >
            {editing ? "Save definition" : "Create shared field"}
          </Button>
          {editing && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void commit(true)}
              >
                Archive definition
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(undefined);
                  setName("");
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
      {(error || schema.query.error) && (
        <div role="alert" className="text-xs text-destructive">
          {error || schema.query.error?.message}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void schema.query.refetch()}
          >
            Reload fields
          </Button>
        </div>
      )}
    </details>
  );
}
