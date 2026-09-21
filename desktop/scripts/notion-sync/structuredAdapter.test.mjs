import test from "node:test";
import assert from "node:assert/strict";
import { createStructuredAdapter } from "./structuredAdapter.mjs";
import { syncStructuredEntity } from "./structuredSync.mjs";
import { SOURCE, SIGNER } from "./adapters.mjs";
const id = "11111111-1111-4111-8111-111111111111",
  blockId = "22222222-2222-4222-8222-222222222222",
  viewId = "33333333-3333-4333-8333-333333333333";
const text = (content) => [
  {
    type: "text",
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: content,
  },
];
function fixture() {
  let state = {},
    clock = 1,
    counter = 0;
  const properties = {
    Name: { id: "title", type: "title", title: text("Fixture") },
    Count: { id: "count", type: "number", number: 2 },
  };
  const page = {
    id,
    parent: { data_source_id: SOURCE },
    properties,
    last_edited_time: "1",
  };
  const block = {
    id: blockId,
    type: "paragraph",
    paragraph: { rich_text: text("Initial"), color: "default" },
    has_children: false,
    last_edited_time: "1",
  };
  const view = {
    id: viewId,
    type: "table",
    name: "Table",
    data_source_id: SOURCE,
    sorts: [],
    filter: null,
    configuration: { type: "table", properties: [] },
    last_edited_time: "1",
  };
  const events = new Map();
  const relay = {
    query: async (filter) =>
      [...events.values()].filter(
        (e) =>
          filter.kinds.includes(e.kind) &&
          filter["#d"].includes(e.tags.find((t) => t[0] === "d")[1]),
      ),
    publish: async (input) => {
      const event = {
        ...input,
        id: (++counter).toString(16).padStart(64, "0"),
        pubkey: SIGNER,
      };
      events.set(input.tags.find((t) => t[0] === "d")[1], event);
      return event;
    },
  };
  const request = async (path, method = "GET", body) => {
    let result;
    if (path === `pages/${id}`) {
      if (method === "PATCH") {
        for (const [key, value] of Object.entries(body.properties)) {
          const prop = Object.values(properties).find((p) => p.id === key);
          Object.assign(prop, value);
        }
        page.last_edited_time = String(++clock);
      }
      result = page;
    } else if (path === `data_sources/${SOURCE}`)
      result = {
        properties: {
          Name: { id: "title", type: "title" },
          Count: { id: "count", type: "number", number: { format: "number" } },
        },
      };
    else if (path.startsWith(`blocks/${id}/children`))
      result = { results: [block], has_more: false };
    else if (path === `blocks/${blockId}`) {
      if (method === "PATCH") {
        Object.assign(block.paragraph, body.paragraph);
        page.last_edited_time = String(++clock);
        block.last_edited_time = page.last_edited_time;
      }
      result = block;
    } else if (path.startsWith("views?"))
      result = { results: [{ id: viewId }], has_more: false };
    else if (path === `views/${viewId}`) {
      if (method === "PATCH") {
        Object.assign(view, body);
        view.last_edited_time = String(++clock);
      }
      result = view;
    } else throw Error(`unexpected ${method} ${path}`);
    return structuredClone(result);
  };
  return {
    events,
    properties,
    view,
    block,
    async pass() {
      const io = createStructuredAdapter({
        request,
        relay,
        pageId: id,
        record: state,
        save: async (next) => {
          state = structuredClone(next);
        },
      });
      return syncStructuredEntity(io, state);
    },
    get state() {
      return state;
    },
    editLocal(target, edit) {
      const key = [...events.keys()].find((k) => k.startsWith(target));
      const event = events.get(key),
        content = JSON.parse(event.content);
      edit(content);
      events.set(key, {
        ...event,
        id: (++counter).toString(16).padStart(64, "0"),
        content: JSON.stringify(content),
      });
    },
  };
}
test("production structured adapter imports Docs/Databases then syncs typed property and view edits back", async () => {
  const f = fixture();
  assert.equal(await f.pass(), "notion-to-local");
  assert.equal(await f.pass(), "unchanged");
  const property = Object.entries(f.state.mapping.bindings).find(
    ([, v]) => v.name === "Count",
  )[0];
  f.editLocal("dbrow:", (row) => {
    row.values[property] = 7;
  });
  f.editLocal("db:", (schema) => {
    schema.views[0].name = "Renamed";
  });
  assert.equal(await f.pass(), "local-to-notion");
  assert.equal(f.properties.Count.number, 7);
  assert.equal(f.view.name, "Renamed");
  assert.equal(await f.pass(), "unchanged");
});

test("a conflicting document/row title never partially updates Notion", async () => {
  const f = fixture();
  await f.pass();
  const key = Object.entries(f.state.mapping.bindings).find(
    ([, b]) => b.definition.type === "title",
  )[0];
  f.editLocal("dbrow:", (row) => {
    row.values[key] = "Conflicting title";
  });
  await assert.rejects(f.pass(), /title-conflict/);
  assert.equal(f.properties.Name.title[0].text.content, "Fixture");
});

// API metadata and typed property values can share the same key.
test("semantic comparison preserves readonly typed property values", async () => {
  const { semantic } = await import("./structuredNotion.mjs");
  for (const type of [
    "created_time",
    "last_edited_time",
    "created_by",
    "last_edited_by",
  ]) {
    const value = type.endsWith("time")
      ? "2026-09-16T00:00:00Z"
      : { id: "author", object: "user" };
    const result = semantic({
      request_id: "transport",
      property: { id: "readonly", type, [type]: value },
    });
    assert.equal(result.request_id, undefined);
    assert.deepEqual(
      result.property[type],
      typeof value === "string" ? value : { id: "author" },
    );
  }
});
