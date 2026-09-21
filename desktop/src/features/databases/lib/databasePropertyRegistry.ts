import type { DatabasePropertyType } from "./databaseSchemaCodec";

export type DatabasePropertyEditorKind =
  | "text"
  | "checkbox"
  | "select"
  | "multi_select"
  | "date"
  | "relation"
  | "unavailable"
  | "read_only";

export type DatabasePropertyRendererKind =
  | "text"
  | "link"
  | "choice"
  | "multi_choice"
  | "date"
  | "checkbox"
  | "files"
  | "relation"
  | "computed";

export type DatabasePropertyRegistration = {
  label: string;
  editor: DatabasePropertyEditorKind;
  renderer: DatabasePropertyRendererKind;
  availableInTable: boolean;
  automatic?: true;
};

/** Typed extension point shared by database property renderers and editors. */
export const DATABASE_PROPERTY_REGISTRY = {
  title: {
    label: "Title",
    editor: "text",
    renderer: "text",
    availableInTable: true,
  },
  text: {
    label: "Text",
    editor: "text",
    renderer: "text",
    availableInTable: true,
  },
  number: {
    label: "Number",
    editor: "text",
    renderer: "text",
    availableInTable: true,
  },
  select: {
    label: "Select",
    editor: "select",
    renderer: "choice",
    availableInTable: true,
  },
  multi_select: {
    label: "Multi select",
    editor: "multi_select",
    renderer: "multi_choice",
    availableInTable: true,
  },
  date: {
    label: "Date",
    editor: "date",
    renderer: "date",
    availableInTable: true,
  },
  checkbox: {
    label: "Checkbox",
    editor: "checkbox",
    renderer: "checkbox",
    availableInTable: true,
  },
  url: {
    label: "URL",
    editor: "text",
    renderer: "link",
    availableInTable: true,
  },
  email: {
    label: "Email",
    editor: "text",
    renderer: "link",
    availableInTable: true,
  },
  phone: {
    label: "Phone",
    editor: "text",
    renderer: "link",
    availableInTable: true,
  },
  person: {
    label: "Person",
    editor: "text",
    renderer: "text",
    availableInTable: true,
  },
  created_time: {
    label: "Created time",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
    automatic: true,
  },
  last_edited_time: {
    label: "Last edited time",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
    automatic: true,
  },
  created_by: {
    label: "Created by",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
    automatic: true,
  },
  last_edited_by: {
    label: "Last edited by",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
    automatic: true,
  },
  relation: {
    label: "Relation",
    editor: "relation",
    renderer: "relation",
    availableInTable: true,
  },
  formula: {
    label: "Formula",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
  },
  rollup: {
    label: "Rollup",
    editor: "read_only",
    renderer: "computed",
    availableInTable: true,
  },
  files: {
    label: "Files",
    editor: "unavailable",
    renderer: "files",
    availableInTable: false,
  },
  status: {
    label: "Status",
    editor: "select",
    renderer: "choice",
    availableInTable: true,
  },
} as const satisfies Record<DatabasePropertyType, DatabasePropertyRegistration>;

/** Returns the renderer/editor registration for a wire property type. */
export function databasePropertyRegistration(
  type: DatabasePropertyType,
): DatabasePropertyRegistration {
  return DATABASE_PROPERTY_REGISTRY[type];
}

/** Human-readable label used anywhere a property type is selected. */
export function databasePropertyLabel(type: DatabasePropertyType): string {
  return DATABASE_PROPERTY_REGISTRY[type].label;
}
