import test from "node:test";
import assert from "node:assert/strict";
import {
  mapNotionProperties,
  unmapNotionProperties,
  mapNotionView,
  unmapNotionView,
} from "./structuredMappings.mjs";
const schema = {
  Name: { id: "title", type: "title" },
  Count: { id: "x%y", type: "number", number: {} },
  Formula: { id: "calc", type: "formula", formula: { expression: "1+1" } },
};
const values = {
  Name: {
    id: "title",
    type: "title",
    title: [{ type: "text", text: { content: "Name" } }],
  },
  Count: { id: "x%y", type: "number", number: 2 },
  Formula: {
    id: "calc",
    type: "formula",
    formula: { type: "number", number: 2 },
  },
};
test("typed values round-trip without rewriting formula or unchanged rich text", () => {
  const m = mapNotionProperties(schema, values);
  assert.equal(m.properties.length, 2);
  assert.deepEqual(unmapNotionProperties(m.values, m), {});
  const id = m.properties.find((p) => p.name === "Count").id;
  assert.deepEqual(unmapNotionProperties({ ...m.values, [id]: 7 }, m), {
    "x%y": { number: 7 },
  });
  assert.deepEqual(m.preserved.Formula.value, values.Formula);
});
test("views map ids and preserve unknown configuration on renamed/sorted view", () => {
  const m = mapNotionProperties(schema, values),
    raw = {
      id: "view",
      name: "Table",
      type: "table",
      configuration: { wrap_cells: true },
      sorts: [],
    };
  const view = mapNotionView(raw, m);
  const result = unmapNotionView(
    {
      ...view,
      name: "Renamed",
      sorts: [{ propertyId: m.properties[1].id, direction: "descending" }],
    },
    view,
    raw,
    m,
  );
  assert.deepEqual(result, {
    name: "Renamed",
    sorts: [{ property: "x%y", direction: "descending" }],
  });
  assert.throws(
    () => mapNotionView({ ...raw, type: "chart" }, m),
    /unsupported/,
  );
  assert.throws(
    () => unmapNotionView({ ...view, filter: { kind: "rule" } }, view, raw, m),
    /unknown/,
  );
});
