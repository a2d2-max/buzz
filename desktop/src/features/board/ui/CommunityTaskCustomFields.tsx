import { useState } from "react";
import {
  type CommunityTaskCustomField,
  type CommunityTaskFieldDefinition,
  applyCommunityTaskFieldDefinitions,
  COMMUNITY_TASK_CUSTOM_FIELDS_MAX,
  COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX,
  COMMUNITY_TASK_CUSTOM_FIELD_TEXT_MAX,
} from "../lib/communityTaskCustomFields";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

/** Shared editor for new tasks and the detail sheet. Changes are saved with the task. */
export function CommunityTaskCustomFields({
  fields,
  onChange,
  disabled = false,
  readonly = false,
  definitions = [],
}: {
  fields: CommunityTaskCustomField[];
  onChange: (fields: CommunityTaskCustomField[]) => void;
  disabled?: boolean;
  readonly?: boolean;
  definitions?: CommunityTaskFieldDefinition[];
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<CommunityTaskCustomField["type"]>("text");
  const replace = (field: CommunityTaskCustomField) => {
    if (!disabled && !readonly)
      onChange(
        fields.map((current) => (current.id === field.id ? field : current)),
      );
  };
  return (
    <section className="space-y-2" aria-label="Custom fields">
      <h3 className="text-xs font-medium text-muted-foreground">
        Custom fields
      </h3>
      {applyCommunityTaskFieldDefinitions(fields, definitions).map((field) => (
        <div
          key={field.id}
          className="space-y-2 rounded-lg border border-border p-2"
        >
          {readonly ? (
            <p className="text-sm">
              {field.name}:{" "}
              {field.value === null
                ? "Not set"
                : field.type === "checkbox"
                  ? field.value
                    ? "Checked"
                    : "Unchecked"
                  : String(field.value)}
            </p>
          ) : (
            <>
              <Input
                aria-label={`Field name: ${field.name}`}
                value={field.name}
                maxLength={COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX}
                required
                disabled={
                  disabled ||
                  definitions.some((definition) => definition.key === field.id)
                }
                onChange={(event) =>
                  replace({ ...field, name: event.target.value })
                }
              />
              {field.type === "checkbox" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    aria-label={`Value: ${field.name}`}
                    type="checkbox"
                    disabled={disabled}
                    checked={field.value === true}
                    onChange={(event) =>
                      replace({ ...field, value: event.target.checked })
                    }
                  />
                  {field.value === null
                    ? "Not set"
                    : field.value
                      ? "Checked"
                      : "Unchecked"}
                </label>
              ) : (
                <Input
                  aria-label={`Value: ${field.name}`}
                  type={field.type === "number" ? "number" : "text"}
                  step="any"
                  maxLength={
                    field.type === "text"
                      ? COMMUNITY_TASK_CUSTOM_FIELD_TEXT_MAX
                      : undefined
                  }
                  disabled={disabled}
                  placeholder="Not set"
                  value={field.value ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (field.type === "text") replace({ ...field, value });
                    else if (value === "") replace({ ...field, value: null });
                    else if (Number.isFinite(event.target.valueAsNumber))
                      replace({ ...field, value: event.target.valueAsNumber });
                  }}
                />
              )}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={disabled}
                  aria-label={`Clear value: ${field.name}`}
                  onClick={() => replace({ ...field, value: null })}
                >
                  Clear value
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove field: ${field.name}`}
                  onClick={() => {
                    if (!disabled)
                      onChange(
                        fields.filter((current) => current.id !== field.id),
                      );
                  }}
                >
                  Remove
                </Button>
              </div>
            </>
          )}
        </div>
      ))}
      {!readonly &&
        fields.length < COMMUNITY_TASK_CUSTOM_FIELDS_MAX &&
        definitions.some((definition) => !definition.archived) && (
          <select
            aria-label="Add shared field"
            value=""
            disabled={disabled}
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            onChange={(event) => {
              const definition = definitions.find(
                (item) => item.key === event.target.value,
              );
              if (
                !definition ||
                definition.archived ||
                fields.some((field) => field.id === definition.key)
              )
                return;
              onChange([
                ...fields,
                {
                  id: definition.key,
                  name: definition.name,
                  type: definition.type,
                  value: null,
                },
              ]);
            }}
          >
            <option value="">Add a shared field…</option>
            {definitions
              .filter(
                (definition) =>
                  !definition.archived &&
                  !fields.some((field) => field.id === definition.key),
              )
              .map((definition) => (
                <option key={definition.key} value={definition.key}>
                  {definition.name} · {definition.type}
                </option>
              ))}
          </select>
        )}
      {!readonly && fields.length < COMMUNITY_TASK_CUSTOM_FIELDS_MAX && (
        <div className="space-y-2">
          <Input
            aria-label="New field name"
            placeholder="Field name"
            disabled={disabled}
            maxLength={COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-2">
            <select
              aria-label="New field type"
              className="rounded-md border border-input bg-background px-2 text-sm"
              disabled={disabled}
              value={type}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "text" ||
                  value === "number" ||
                  value === "checkbox"
                )
                  setType(value);
              }}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="checkbox">Checkbox</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={disabled || !name.trim()}
              onClick={() => {
                if (disabled || !name.trim()) return;
                onChange([
                  ...fields,
                  {
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    type,
                    value: null,
                  },
                ]);
                setName("");
              }}
            >
              Add field
            </Button>
          </div>
        </div>
      )}
      {!fields.length && readonly && (
        <p className="text-sm text-muted-foreground">No custom fields.</p>
      )}
    </section>
  );
}
