import type {
  DatabaseFilter,
  DatabaseGroup,
  DatabaseProperty,
  DatabaseSchema,
  DatabaseSort,
  DatabaseStatusChoice,
  DatabaseView,
} from "./databaseSchemaCodec";
import { isDatabasePropertyId } from "./databaseValue";

type EditableSchema = Pick<DatabaseSchema, "properties" | "views">;
type ViewType = DatabaseView["type"];

const BOARD_PROPERTY_TYPES = new Set(["select", "status", "person"]);

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

function propertyById<T extends EditableSchema>(schema: T, propertyId: string) {
  const property = schema.properties.find(
    (candidate) => candidate.id === propertyId,
  );
  if (!property) throw new Error("Database property no longer exists.");
  return property;
}

function compatibleGroupProperty(
  property: DatabaseProperty,
  type: ViewType,
): boolean {
  if (type === "board") return BOARD_PROPERTY_TYPES.has(property.type);
  if (type === "calendar") return property.type === "date";
  return true;
}

function defaultGroup<T extends EditableSchema>(
  schema: T,
  type: ViewType,
): DatabaseGroup | undefined {
  if (type !== "board" && type !== "calendar") return undefined;
  const property = schema.properties.find((candidate) =>
    compatibleGroupProperty(candidate, type),
  );
  return property
    ? { propertyId: property.id, direction: "ascending" }
    : undefined;
}

function assertFilter(
  filter: DatabaseFilter,
  propertyIds: ReadonlySet<string>,
  depth = 0,
): void {
  if (depth > 8) throw new Error("Filter nesting is too deep.");
  if (filter.kind === "rule") {
    if (!propertyIds.has(filter.propertyId)) {
      throw new Error("Filter property no longer exists.");
    }
    return;
  }
  if (filter.filters.length === 0)
    throw new Error("Empty filter groups are not saved.");
  if (filter.filters.length > 100)
    throw new Error("Filter group is too large.");
  for (const child of filter.filters) {
    assertFilter(child, propertyIds, depth + 1);
  }
}

/** Creates one saved view without changing existing views. */
export function createDatabaseView<T extends EditableSchema>(
  schema: T,
  input: { id: string; name: string; type: ViewType },
): T {
  if (!isDatabasePropertyId(input.id))
    throw new Error("Invalid database view id.");
  if (schema.views.some((view) => view.id === input.id)) {
    throw new Error("A view with this id already exists.");
  }
  const source = schema.views[0];
  const name = input.name.trim() || "Untitled view";
  const group = defaultGroup(schema, input.type);
  const view: DatabaseView = {
    id: input.id,
    name,
    type: input.type,
    sorts: [],
    visiblePropertyIds:
      source?.visiblePropertyIds ?? schema.properties.map(({ id }) => id),
    ...(source?.propertyWidths
      ? { propertyWidths: { ...source.propertyWidths } }
      : {}),
    ...(group ? { group } : {}),
  };
  return { ...schema, views: [...schema.views, view] };
}

/** Renames one saved view and applies the non-empty fallback. */
export function renameDatabaseView<T extends EditableSchema>(
  schema: T,
  viewId: string,
  name: string,
): T {
  return replaceView(schema, viewId, (view) => ({
    ...view,
    name: name.trim() || "Untitled view",
  }));
}

/** Changes a renderer while retaining that view's saved state verbatim. */
export function changeDatabaseViewType<T extends EditableSchema>(
  schema: T,
  viewId: string,
  type: ViewType,
): T {
  return replaceView(schema, viewId, (view) =>
    view.type === type ? view : { ...view, type },
  );
}

/** Replaces or clears one view's validated typed filter. */
export function setDatabaseViewFilter<T extends EditableSchema>(
  schema: T,
  viewId: string,
  filter: DatabaseFilter | null,
): T {
  if (filter) {
    assertFilter(filter, new Set(schema.properties.map(({ id }) => id)));
  }
  return replaceView(schema, viewId, (view) => {
    if (filter) return { ...view, filter };
    const { filter: _filter, ...withoutFilter } = view;
    return withoutFilter;
  });
}

/** Stores ordered, unique sorts for one view. */
export function setDatabaseViewSorts<T extends EditableSchema>(
  schema: T,
  viewId: string,
  sorts: DatabaseSort[],
): T {
  const ids = new Set<string>();
  for (const sort of sorts) {
    propertyById(schema, sort.propertyId);
    if (ids.has(sort.propertyId)) throw new Error("Duplicate sort property.");
    ids.add(sort.propertyId);
  }
  return replaceView(schema, viewId, (view) => ({ ...view, sorts }));
}

/** Stores or clears a compatible grouping axis for one view. */
export function setDatabaseViewGroup<T extends EditableSchema>(
  schema: T,
  viewId: string,
  group: DatabaseGroup | null,
): T {
  return replaceView(schema, viewId, (view) => {
    if (!group) {
      const { group: _group, ...withoutGroup } = view;
      return withoutGroup;
    }
    const property = propertyById(schema, group.propertyId);
    if (!compatibleGroupProperty(property, view.type)) {
      throw new Error(
        view.type === "board"
          ? "Board grouping requires Select, Status, or Person."
          : "Calendar grouping requires a Date property.",
      );
    }
    return { ...view, group };
  });
}

/** Updates status choices while retaining ids by normalized name. */
export function updateDatabaseStatusChoices<T extends EditableSchema>(
  schema: T,
  propertyId: string,
  choices: Array<{
    id?: string;
    name: string;
    group: DatabaseStatusChoice["group"];
    color?: string;
  }>,
): T {
  const property = propertyById(schema, propertyId);
  if (property.type !== "status")
    throw new Error("This property is not Status.");
  const existing = new Map(
    property.options.choices.map((choice) => [
      choice.name.trim().toLocaleLowerCase(),
      choice,
    ]),
  );
  const ids = new Set<string>();
  const nextChoices = choices.map((input) => {
    const name = input.name.trim();
    if (!name) throw new Error("Status choice names cannot be empty.");
    const current = existing.get(name.toLocaleLowerCase());
    const id = input.id ?? current?.id;
    if (!id || !isDatabasePropertyId(id) || ids.has(id)) {
      throw new Error("Status choice ids must be unique and valid.");
    }
    ids.add(id);
    return {
      id,
      name,
      group: input.group,
      ...((input.color ?? current?.color)
        ? { color: input.color ?? current?.color }
        : {}),
    } as DatabaseStatusChoice;
  });
  return {
    ...schema,
    properties: schema.properties.map((candidate) =>
      candidate.id === property.id
        ? { ...property, options: { choices: nextChoices } }
        : candidate,
    ),
  };
}
