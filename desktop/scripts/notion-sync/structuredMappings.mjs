/** Stable local keys for Notion's short, percent-encoded property identifiers. */
export const propertyKey = (id) => `n_${Buffer.from(id).toString("hex")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const types = {
  title: "title",
  rich_text: "text",
  number: "number",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone_number: "phone",
  date: "date",
  select: "select",
  multi_select: "multi_select",
};
export function mapNotionProperties(schema, values) {
  const properties = [],
    row = {},
    bindings = {},
    preserved = {};
  for (const [name, definition] of Object.entries(schema)) {
    const value =
      values[name] ?? Object.values(values).find((v) => v.id === definition.id);
    if (!value) throw Error("notion-property-missing");
    if (value.has_more) throw Error("notion-property-incomplete");
    const type = types[definition.type],
      id = propertyKey(definition.id);
    if (!type) {
      preserved[name] = { definition, value };
      continue;
    }
    if (definition.type !== value.type)
      throw Error("notion-property-type-mismatch");
    const v = value[value.type];
    const property = { id, name, type };
    if (type === "number")
      property.options = {
        format: definition.number?.format === "percent" ? "percent" : "decimal",
      };
    if (type === "select" || type === "multi_select")
      property.options = {
        choices: definition[definition.type].options.map((o) => ({
          id: propertyKey(o.id),
          name: o.name,
          color: o.color,
        })),
      };
    let local;
    switch (value.type) {
      case "title":
      case "rich_text":
        local = v.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
        break;
      case "date":
        local = v
          ? {
              start: v.start,
              ...(v.end ? { end: v.end } : {}),
              includeTime: v.start.includes("T"),
            }
          : null;
        break;
      case "select":
        local = v?.id ? propertyKey(v.id) : null;
        break;
      case "multi_select":
        local = v.map((o) => propertyKey(o.id));
        break;
      default:
        local = v;
    }
    properties.push(property);
    row[id] = local;
    bindings[id] = { name, definition, value, local };
  }
  return { properties, values: row, bindings, preserved };
}
/** Patch only edited supported fields; raw rich text, computed values and unknown properties survive. */
export function unmapNotionProperties(values, mapping) {
  const patches = {};
  for (const key of Object.keys(values))
    if (!mapping.bindings[key]) throw Error("notion-unmapped-property-edit");
  for (const [id, binding] of Object.entries(mapping.bindings)) {
    if (!(id in values)) throw Error("notion-property-deletion-needs-review");
    const next = values[id],
      type = binding.definition.type;
    if (same(next, binding.local)) continue;
    let value = next;
    if (type === "title" || type === "rich_text") {
      if (typeof next !== "string") throw Error("notion-text-value-invalid");
      // Preserve original rich-text annotations by refusing to flatten annotated values.
      if (
        binding.value[type].some(
          (t) =>
            t.type !== "text" ||
            t.text?.link ||
            Object.entries(t.annotations ?? {}).some(([k, v]) =>
              k === "color" ? v !== "default" : v === true,
            ),
        )
      )
        throw Error("notion-rich-property-edit-needs-review");
      value = [];
      for (let i = 0; i < next.length; i += 2000)
        value.push({
          type: "text",
          text: { content: next.slice(i, i + 2000) },
        });
    } else if (type === "select" || type === "multi_select") {
      const choices = new Map(
        binding.definition[type].options.map((o) => [propertyKey(o.id), o.id]),
      );
      const ids = type === "select" ? (next === null ? [] : [next]) : next;
      if (!Array.isArray(ids) || ids.some((id) => !choices.has(id)))
        throw Error("notion-option-unknown");
      value =
        type === "select"
          ? next === null
            ? null
            : { id: choices.get(next) }
          : ids.map((id) => ({ id: choices.get(id) }));
    } else if (type === "date")
      value =
        next === null
          ? null
          : {
              start: next.start,
              end: next.end ?? null,
              time_zone: binding.value.date?.time_zone ?? null,
            };
    else if (
      type === "number" &&
      next !== null &&
      (typeof next !== "number" || !Number.isFinite(next))
    )
      throw Error("notion-number-invalid");
    else if (type === "checkbox" && typeof next !== "boolean")
      throw Error("notion-checkbox-invalid");
    else if (
      ["url", "email", "phone_number"].includes(type) &&
      next !== null &&
      typeof next !== "string"
    )
      throw Error("notion-string-invalid");
    patches[binding.definition.id] = { [type]: value };
  }
  return patches;
}
function filterToLocal(filter, resolve, mapping) {
  if (!filter) return undefined;
  if (filter.and || filter.or)
    return {
      kind: "group",
      operator: filter.and ? "and" : "or",
      filters: (filter.and ?? filter.or).map((f) =>
        filterToLocal(f, resolve, mapping),
      ),
    };
  const propertyId = resolve(filter.property),
    type = Object.keys(filter).find((k) => k !== "property"),
    condition = filter[type];
  if (!propertyId || !condition || Object.keys(condition).length !== 1)
    throw Error("notion-view-filter-unsupported");
  const [operator, rawValue] = Object.entries(condition)[0];
  let value = rawValue;
  const binding = mapping.bindings[propertyId];
  if (
    ["select", "multi_select"].includes(type) &&
    !["is_empty", "is_not_empty"].includes(operator)
  ) {
    const option = binding.definition[type].options.find(
      (o) => o.name === value,
    );
    if (!option) throw Error("notion-view-option-unknown");
    value = propertyKey(option.id);
  }
  if (
    ![
      "equals",
      "does_not_equal",
      "contains",
      "does_not_contain",
      "is_empty",
      "is_not_empty",
      "before",
      "after",
      "on_or_before",
      "on_or_after",
      "greater_than",
      "greater_than_or_equal_to",
      "less_than",
      "less_than_or_equal_to",
    ].includes(operator)
  )
    throw Error("notion-view-filter-unsupported");
  return {
    kind: "rule",
    propertyId,
    operator:
      {
        does_not_equal: "not_equals",
        does_not_contain: "not_contains",
        greater_than_or_equal_to: "greater_than_or_equal",
        less_than_or_equal_to: "less_than_or_equal",
      }[operator] ?? operator,
    ...(["is_empty", "is_not_empty"].includes(operator) ? {} : { value }),
  };
}
export function mapNotionView(view, mapping) {
  if (!["table", "board", "calendar", "gallery"].includes(view.type))
    throw Error("notion-view-layout-unsupported");
  const resolve = (key) =>
    Object.entries(mapping.bindings).find(
      ([, b]) => b.name === key || b.definition.id === key,
    )?.[0];
  const c = view.configuration ?? {};
  const sorts = (view.sorts ?? []).map((s) => {
    const propertyId = resolve(s.property);
    if (!propertyId) throw Error("notion-view-sort-unsupported");
    return { propertyId, direction: s.direction };
  });
  const visiblePropertyIds = c.properties
    ? c.properties
        .filter((p) => p.visible !== false)
        .map((p) => {
          const id = resolve(p.property_id);
          if (!id) throw Error("notion-view-property-unsupported");
          return id;
        })
    : mapping.properties.map((p) => p.id);
  const filter = filterToLocal(view.filter, resolve, mapping);
  const group = c.group_by
    ? { propertyId: resolve(c.group_by.property_id), direction: "ascending" }
    : undefined;
  if (group && !group.propertyId) throw Error("notion-view-group-unsupported");
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    sorts,
    visiblePropertyIds,
    ...(filter ? { filter } : {}),
    ...(group ? { group } : {}),
  };
}
export function unmapNotionView(next, before, raw, mapping) {
  if (next.id !== before.id || next.type !== before.type)
    throw Error("notion-view-type-change-needs-review");
  const original = (id) => {
    const b = mapping.bindings[id];
    if (!b) throw Error("notion-view-property-unknown");
    return b.definition.id;
  };
  const patch = {};
  if (next.name !== before.name) patch.name = next.name;
  if (!same(next.sorts, before.sorts))
    patch.sorts = next.sorts.map((s) => ({
      property: original(s.propertyId),
      direction: s.direction,
    }));
  // Filters and grouping remain protected until their full semantic mapping is available.
  if (!same(next.filter, before.filter))
    patch.filter = filterToNotion(next.filter, mapping);
  if (!same(next.group, before.group))
    throw Error("notion-view-group-edit-needs-review");
  if (!same(next.visiblePropertyIds, before.visiblePropertyIds)) {
    const visible = new Set(next.visiblePropertyIds.map(original));
    patch.configuration = {
      ...raw.configuration,
      type: raw.type,
      properties: mapping.properties.map((p) => ({
        ...(raw.configuration?.properties ?? []).find(
          (v) => v.property_id === original(p.id),
        ),
        property_id: original(p.id),
        visible: visible.has(original(p.id)),
      })),
    };
  }
  return patch;
}

function filterToNotion(filter, mapping, depth = 0) {
  if (!filter) return null;
  if (depth > 8) throw Error("notion-filter-depth-limit");
  if (filter.kind === "group")
    return {
      [filter.operator]: filter.filters.map((f) =>
        filterToNotion(f, mapping, depth + 1),
      ),
    };
  const binding = mapping.bindings[filter.propertyId];
  if (!binding) throw Error("notion-view-property-unknown");
  const type = binding.definition.type;
  let value = filter.value,
    operator =
      {
        not_equals: "does_not_equal",
        not_contains: "does_not_contain",
        greater_than_or_equal: "greater_than_or_equal_to",
        less_than_or_equal: "less_than_or_equal_to",
      }[filter.operator] ?? filter.operator;
  if (["is_empty", "is_not_empty"].includes(operator)) value = true;
  if (
    ["select", "multi_select"].includes(type) &&
    !["is_empty", "is_not_empty"].includes(operator)
  ) {
    const choice = binding.definition[type].options.find(
      (o) => propertyKey(o.id) === value,
    );
    if (!choice) throw Error("notion-view-option-unknown");
    value = choice.name;
  }
  return { property: binding.definition.id, [type]: { [operator]: value } };
}
