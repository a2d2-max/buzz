import type { RelayEvent } from "@/shared/api/types";
/** Task-local fields travel with the signed task revision; no shared schema. */
export type CommunityTaskCustomField = { id: string; name: string } & (
  | { type: "text"; value: string | null }
  | { type: "number"; value: number | null }
  | { type: "checkbox"; value: boolean | null }
);
export const COMMUNITY_TASK_CUSTOM_FIELDS_MAX = 20;
export const COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX = 64;
export const COMMUNITY_TASK_CUSTOM_FIELD_TEXT_MAX = 1024;

/** Reject malformed optional metadata without hiding the task. Empty means explicit clear. */
export function parseCommunityTaskCustomFields(
  value: unknown,
): CommunityTaskCustomField[] | undefined {
  if (!Array.isArray(value) || value.length > COMMUNITY_TASK_CUSTOM_FIELDS_MAX)
    return undefined;
  const result: CommunityTaskCustomField[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return undefined;
    const { id, name, type, value: fieldValue } = entry;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX
    )
      return undefined;
    ids.add(id);
    if (
      type === "text" &&
      (fieldValue === null ||
        (typeof fieldValue === "string" &&
          fieldValue.length <= COMMUNITY_TASK_CUSTOM_FIELD_TEXT_MAX))
    ) {
      result.push({ id, name, type, value: fieldValue });
    } else if (
      type === "number" &&
      (fieldValue === null ||
        (typeof fieldValue === "number" && Number.isFinite(fieldValue)))
    ) {
      result.push({ id, name, type, value: fieldValue });
    } else if (
      type === "checkbox" &&
      (fieldValue === null || typeof fieldValue === "boolean")
    ) {
      result.push({ id, name, type, value: fieldValue });
    } else return undefined;
  }
  return result;
}

export const COMMUNITY_TASK_FIELD_PREFIX = "community-task-field:";
export type CommunityTaskFieldDefinition = {
  id: string;
  key: string;
  owner: string;
  name: string;
  type: CommunityTaskCustomField["type"];
  archived: boolean;
  event: RelayEvent;
};
/** A definition belongs to its signer; another signer publishing the same id cannot rename it. */
export function parseCommunityTaskFieldDefinition(
  event: RelayEvent,
): CommunityTaskFieldDefinition | null {
  const ds = event.tags.filter((tag) => tag[0] === "d");
  if (
    event.kind !== 30078 ||
    !/^[a-f0-9]{64}$/.test(event.pubkey) ||
    ds.length !== 1 ||
    !ds[0][1]?.startsWith(COMMUNITY_TASK_FIELD_PREFIX)
  )
    return null;
  const id = ds[0][1].slice(COMMUNITY_TASK_FIELD_PREFIX.length);
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(id) || event.content.length > 4096)
    return null;
  try {
    const value = JSON.parse(event.content);
    if (
      value?.version !== 1 ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > COMMUNITY_TASK_CUSTOM_FIELD_NAME_MAX ||
      !["text", "number", "checkbox"].includes(value.type) ||
      typeof value.archived !== "boolean"
    )
      return null;
    return {
      id,
      key: `${event.pubkey}:${id}`,
      owner: event.pubkey,
      name: value.name,
      type: value.type,
      archived: value.archived,
      event,
    };
  } catch {
    return null;
  }
}
/** Renames propagate without mutating signed values. Archives and unknown/type-changed definitions retain their saved snapshot. */
export function applyCommunityTaskFieldDefinitions(
  fields: CommunityTaskCustomField[],
  definitions: CommunityTaskFieldDefinition[],
): CommunityTaskCustomField[] {
  const byKey = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  return fields.map((field) => {
    const definition = byKey.get(field.id);
    return definition && !definition.archived && definition.type === field.type
      ? { ...field, name: definition.name }
      : field;
  });
}
