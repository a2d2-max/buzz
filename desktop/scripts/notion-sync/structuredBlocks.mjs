import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../../docs-editor/package.json", import.meta.url),
);
const Y = require("yjs");
const supported = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
]);
const encode = (value) => Buffer.from(value).toString("base64");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64"));
const canonical = (value) => JSON.stringify(value);
function ytext(parts) {
  const text = new Y.Text();
  text.applyDelta(
    parts.map((part) => ({
      insert: part.plain_text ?? part.text?.content ?? "",
      attributes: {
        ...(part.annotations?.bold ? { bold: true } : {}),
        ...(part.annotations?.italic ? { italic: true } : {}),
        ...(part.annotations?.strikethrough ? { strike: true } : {}),
        ...(part.annotations?.underline ? { underline: true } : {}),
        ...(part.annotations?.code ? { code: true } : {}),
        ...(part.text?.link?.url ? { link: part.text.link.url } : {}),
        ...(part.annotations?.color && part.annotations.color !== "default"
          ? { color: part.annotations.color }
          : {}),
      },
    })),
  );
  return text;
}
function richText(text) {
  return text.toDelta().flatMap((part) => {
    if (typeof part.insert !== "string")
      throw Error("notion-inline-embed-edit-unsupported");
    const a = part.attributes ?? {},
      chunks = [];
    for (let i = 0; i < part.insert.length; i += 2000)
      chunks.push({
        type: "text",
        text: {
          content: part.insert.slice(i, i + 2000),
          ...(a.link ? { link: { url: a.link } } : {}),
        },
        annotations: {
          bold: !!a.bold,
          italic: !!a.italic,
          strikethrough: !!a.strike,
          underline: !!a.underline,
          code: !!a.code,
          color: a.color ?? "default",
        },
      });
    return chunks;
  });
}
function add(blocks, id, flavour, version, props, children = []) {
  const block = new Y.Map();
  blocks.set(id, block);
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", version);
  block.set("sys:children", Y.Array.from(children));
  for (const [key, value] of Object.entries(props))
    block.set(`prop:${key}`, value);
  return block;
}
/** Stable source block ids and original unsupported payloads travel inside lossless Yjs state. */
export function notionBlocksToAffine({ id, title, blocks }) {
  const root = new Y.Doc({ guid: id }),
    doc = new Y.Doc({ guid: id });
  root.getMap("spaces").set(id, doc);
  const meta = new Y.Map();
  meta.set("id", id);
  meta.set("title", title);
  meta.set("tags", new Y.Array());
  meta.set("createDate", Date.now());
  root.getMap("metadata").set("pages", Y.Array.from([meta]));
  const store = doc.getMap("blocks"),
    source = { version: 1, blocks, fingerprints: {} };
  add(store, "root", "affine:page", 2, { title: new Y.Text(title) }, ["note"]);
  const walk = (items, depth = 0) => {
    if (depth > 32 || store.size > 10000) throw Error("notion-block-limit");
    return items.map((item) => {
      if (!item.id || store.has(item.id))
        throw Error("notion-block-id-duplicate");
      const value = item[item.type] ?? {},
        editable =
          supported.has(item.type) &&
          (value.rich_text ?? []).every((part) => part.type === "text");
      const list = [
        "bulleted_list_item",
        "numbered_list_item",
        "to_do",
      ].includes(item.type);
      const props = editable
        ? {
            text: ytext(value.rich_text ?? []),
            type: list
              ? {
                  bulleted_list_item: "bulleted",
                  numbered_list_item: "numbered",
                  to_do: "todo",
                }[item.type]
              : ({
                  heading_1: "h1",
                  heading_2: "h2",
                  heading_3: "h3",
                  quote: "quote",
                }[item.type] ?? "text"),
            ...(list
              ? { checked: !!value.checked, collapsed: false, order: null }
              : {}),
          }
        : {
            type: "text",
            text: new Y.Text(
              `[Notion ${item.type}: preserved; edit in Notion]`,
            ),
          };
      const block = add(
        store,
        item.id,
        list && editable ? "affine:list" : "affine:paragraph",
        1,
        props,
      );
      const children = editable ? walk(item.children ?? [], depth + 1) : [];
      block.get("sys:children").push(children);
      source.fingerprints[item.id] = {
        editable,
        flavour: block.get("sys:flavour"),
        type: props.type,
        text: canonical(block.get("prop:text").toDelta()),
        children,
        checked: props.checked,
      };
      return item.id;
    });
  };
  add(
    store,
    "note",
    "affine:note",
    1,
    {
      xywh: "[0,0,800,600]",
      index: "a0",
      background: "--affine-background-secondary-color",
      displayMode: "both",
      hidden: false,
    },
    walk(blocks),
  );
  root.getMap("notionSource").set("data", JSON.stringify(source));
  const snapshot = {
    entry: id,
    root: encode(Y.encodeStateAsUpdate(root)),
    docs: [{ id, state: encode(Y.encodeStateAsUpdate(doc)) }],
    blobs: [],
  };
  const affine = {
    version: 2,
    data: encode(Buffer.from(JSON.stringify(snapshot))),
  };
  doc.destroy();
  root.destroy();
  return affine;
}
/** Produce individual block PATCH/DELETE operations; unsupported blocks cannot disappear silently. */
export function affineToNotionOperations(affine) {
  if (![1, 2].includes(affine.version) || affine.data.length > 32 * 1024 * 1024)
    throw Error("notion-affine-payload-invalid");
  const snapshot = JSON.parse(
    Buffer.from(affine.data, "base64").toString("utf8"),
  );
  const root = new Y.Doc(),
    doc = new Y.Doc();
  try {
    Y.applyUpdate(root, decode(snapshot.root));
    const item = snapshot.docs.find((d) => d.id === snapshot.entry);
    if (!item) throw Error("notion-entry-missing");
    Y.applyUpdate(doc, decode(item.state));
    const source = JSON.parse(
      root.getMap("notionSource").get("data") ?? "null",
    );
    if (source?.version !== 1) throw Error("notion-source-mapping-missing");
    const store = doc.getMap("blocks"),
      operations = [],
      seen = new Set(["root", "note"]);
    const walk = (items, parent) => {
      const children = store.get(parent)?.get("sys:children")?.toArray() ?? [];
      const expected = items.filter((i) => store.has(i.id)).map((i) => i.id);
      if (canonical(children) !== canonical(expected))
        throw Error("notion-block-insert-or-reorder-needs-review");
      for (const original of items) {
        seen.add(original.id);
        const block = store.get(original.id),
          before = source.fingerprints[original.id];
        if (!block) {
          if (!before.editable || original.children?.length)
            throw Error("notion-unsupported-or-nested-deletion-needs-review");
          operations.push({
            method: "DELETE",
            path: `blocks/${original.id}`,
            source: original,
          });
          continue;
        }
        if (
          block.get("sys:flavour") !== before.flavour ||
          block.get("prop:type") !== before.type
        )
          throw Error("notion-block-type-change-needs-review");
        const text = block.get("prop:text");
        if (!(text instanceof Y.Text)) throw Error("notion-text-missing");
        const changed =
          canonical(text.toDelta()) !== before.text ||
          (before.checked !== undefined &&
            block.get("prop:checked") !== before.checked);
        if (!before.editable) {
          if (changed || block.get("sys:children").length)
            throw Error("notion-unsupported-block-edited");
          continue;
        }
        if (changed)
          operations.push({
            method: "PATCH",
            path: `blocks/${original.id}`,
            body: {
              [original.type]: {
                rich_text: richText(text),
                ...(original.type === "to_do"
                  ? { checked: !!block.get("prop:checked") }
                  : {}),
              },
            },
            source: original,
          });
        walk(original.children ?? [], original.id);
      }
    };
    walk(source.blocks, "note");
    for (const id of store.keys())
      if (!seen.has(id)) throw Error("notion-new-block-needs-review");
    return {
      title: store.get("root").get("prop:title").toString(),
      operations,
      source,
    };
  } finally {
    root.destroy();
    doc.destroy();
  }
}
