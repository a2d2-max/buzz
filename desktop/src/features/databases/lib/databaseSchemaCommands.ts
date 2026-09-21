import type {
  DatabaseProperty,
  DatabasePropertyDefinition,
  DatabasePropertyType,
  DatabaseSchema,
  DatabaseView,
} from "./databaseSchemaCodec";
import {
  databasePropertyDefinition,
  DATABASE_PROPERTY_TYPES,
} from "./databaseSchemaCodec";
import { databasePropertyRegistration } from "./databasePropertyRegistry";

type EditableSchema = Pick<DatabaseSchema, "properties" | "views">;

export function databasePropertyIsReadOnly(
  property: DatabaseProperty,
): boolean {
  return databasePropertyRegistration(property.type).editor === "read_only";
}

function replaceView<T extends EditableSchema>(
  schema: T,
  viewId: string,
  update: (view: DatabaseView) => DatabaseView,
): T {
  let found = false;
  const views = schema.views.map((view) => {
    if (view.id !== viewId) return view;
    found = true;
    return update(view);
  });
  if (!found) throw new Error("Database view no longer exists.");
  return { ...schema, views };
}

function requireProperty<T extends EditableSchema>(schema: T, id: string) {
  const property = schema.properties.find((candidate) => candidate.id === id);
  if (!property) throw new Error("Database property no longer exists.");
  return property;
}

export function addDatabaseProperty<T extends EditableSchema>(
  schema: T,
  property: DatabaseProperty,
): T {
  if (schema.properties.some((candidate) => candidate.id === property.id)) {
    throw new Error("A property with this id already exists.");
  }
  if (property.type === "title") {
    throw new Error("Promote an existing property to change the title.");
  }
  return {
    ...schema,
    properties: [...schema.properties, property],
    views: schema.views.map((view) => ({
      ...view,
      visiblePropertyIds: [...view.visiblePropertyIds, property.id],
    })),
  };
}

export function changeDatabasePropertyType<T extends EditableSchema>(
  schema: T,
  propertyId: string,
  type: DatabasePropertyType,
  definitionOverride?: DatabasePropertyDefinition,
): T {
  const current = requireProperty(schema, propertyId);
  if (definitionOverride && definitionOverride.type !== type) {
    throw new Error("The replacement property definition has the wrong type.");
  }
  if (current.type === type) return schema;
  if (current.type === "title" && type !== "title") {
    throw new Error("Promote another property before changing the title type.");
  }
  const properties = schema.properties.map((property) => {
    if (type === "title" && property.type === "title") {
      return propertyWithType(property, "text");
    }
    if (property.id !== propertyId) return property;
    return propertyWithType(property, type, definitionOverride);
  });
  return { ...schema, properties };
}

function propertyWithType(
  property: DatabaseProperty,
  type: DatabasePropertyType,
  definitionOverride?: DatabasePropertyDefinition,
): DatabaseProperty {
  const restored = property.priorDefinitions?.find(
    (definition) => definition.type === type,
  );
  const definition: DatabasePropertyDefinition =
    definitionOverride ??
    restored ??
    databasePropertyDefinition(
      defaultDatabaseProperty(property.id, property.name, type),
    );
  const priorDefinitions = [
    databasePropertyDefinition(property),
    ...(property.priorDefinitions ?? []).filter(
      (candidate) =>
        candidate.type !== type && candidate.type !== property.type,
    ),
  ].slice(0, DATABASE_PROPERTY_TYPES.length - 1);
  return {
    id: property.id,
    name: property.name,
    ...definition,
    priorDefinitions,
  } as DatabaseProperty;
}

export function defaultDatabaseProperty(
  id: string,
  name: string,
  type: DatabasePropertyType,
): DatabaseProperty {
  if (type === "number") {
    return { id, name, type, options: { format: "decimal" } };
  }
  if (type === "select" || type === "multi_select") {
    return { id, name, type, options: { choices: [] } };
  }
  if (type === "status") {
    return {
      id,
      name,
      type,
      options: {
        choices: [
          { id: "todo", name: "To do", group: "todo" },
          { id: "doing", name: "In progress", group: "doing" },
          { id: "done", name: "Done", group: "done" },
        ],
      },
    };
  }
  if (type === "relation") {
    throw new Error("Relations require a target database.");
  }
  if (type === "formula")
    return { id, name, type, options: { expression: "" } };
  if (type === "rollup") {
    throw new Error("Rollups require relation and target properties.");
  }
  return { id, name, type };
}

export function setDatabasePropertyVisible<T extends EditableSchema>(
  schema: T,
  viewId: string,
  propertyId: string,
  visible: boolean,
): T {
  const property = requireProperty(schema, propertyId);
  if (!visible && property.type === "title") {
    throw new Error("The title property must stay visible.");
  }
  return replaceView(schema, viewId, (view) => {
    const without = view.visiblePropertyIds.filter((id) => id !== propertyId);
    return {
      ...view,
      visiblePropertyIds: visible ? [...without, propertyId] : without,
    };
  });
}

export function moveDatabaseProperty<T extends EditableSchema>(
  schema: T,
  viewId: string,
  propertyId: string,
  direction: -1 | 1,
): T {
  requireProperty(schema, propertyId);
  return replaceView(schema, viewId, (view) => {
    const ids = [...view.visiblePropertyIds];
    const index = ids.indexOf(propertyId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return view;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    return { ...view, visiblePropertyIds: ids };
  });
}

export function setDatabasePropertyWidth<T extends EditableSchema>(
  schema: T,
  viewId: string,
  propertyId: string,
  width: number,
): T {
  requireProperty(schema, propertyId);
  if (!Number.isFinite(width)) throw new Error("Column width must be finite.");
  const bounded = Math.min(720, Math.max(96, Math.round(width)));
  return replaceView(schema, viewId, (view) => ({
    ...view,
    propertyWidths: { ...view.propertyWidths, [propertyId]: bounded },
  }));
}

export function renameDatabaseProperty<T extends EditableSchema>(
  schema: T,
  propertyId: string,
  name: string,
): T {
  requireProperty(schema, propertyId);
  return {
    ...schema,
    properties: schema.properties.map((property) =>
      property.id === propertyId
        ? { ...property, name: name.trim() }
        : property,
    ),
  };
}
