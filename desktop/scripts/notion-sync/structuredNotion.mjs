import { DATABASE, SOURCE, idKey } from "./adapters.mjs";
import { fingerprint } from "./structuredSync.mjs";
import {
  notionBlocksToAffine,
  affineToNotionOperations,
} from "./structuredBlocks.mjs";
import {
  mapNotionProperties,
  unmapNotionProperties,
  mapNotionView,
  unmapNotionView,
} from "./structuredMappings.mjs";
const clone = (v) => structuredClone(v);
/** Strip API transport/computed annotations while keeping all source content. */
export function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value?.type === "text" && value.text)
    return {
      type: "text",
      text: { content: value.text.content, link: value.text.link ?? null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
        ...value.annotations,
      },
    };
  if (!value || typeof value !== "object") return value;
  const ignored = new Set([
    "created_time",
    "last_edited_time",
    "created_by",
    "last_edited_by",
    "request_id",
    "plain_text",
    "href",
    "object",
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !ignored.has(k) || k === value.type)
      .map(([k, v]) => [k, semantic(v)]),
  );
}
export function selectedProperties(properties, ids) {
  return semantic(
    Object.fromEntries(
      Object.values(properties)
        .filter((p) => ids.includes(p.id))
        .map((p) => [p.id, p]),
    ),
  );
}
export function blockContent(block) {
  if (block.archived || block.in_trash) return null;
  return semantic({
    id: block.id,
    type: block.type,
    [block.type]: block[block.type],
  });
}
/** Bounded complete reads; missing blocks/properties never become an empty authoritative document. */
export async function readStructuredNotion(request, id) {
  const page = await request(`pages/${id}`);
  if (
    idKey(page.parent?.data_source_id ?? "") !== idKey(SOURCE) ||
    page.archived ||
    page.in_trash
  )
    return { deleted: true };
  const schema = await request(`data_sources/${SOURCE}`);
  let count = 0;
  async function children(parent, depth = 0) {
    if (depth > 32) throw Error("notion-block-depth-limit");
    const all = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const response = await request(
        `blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!Array.isArray(response.results))
        throw Error("notion-block-response-invalid");
      for (const block of response.results) {
        if (++count > 10000) throw Error("notion-block-count-limit");
        all.push({
          ...block,
          children:
            block.has_children &&
            !["child_page", "child_database", "synced_block"].includes(
              block.type,
            )
              ? await children(block.id, depth + 1)
              : [],
        });
      }
      if (response.has_more === false) return all;
      if (!response.next_cursor || response.next_cursor === cursor)
        throw Error("notion-block-pagination-incomplete");
      cursor = response.next_cursor;
    }
    throw Error("notion-block-pagination-limit");
  }
  const blocks = await children(id),
    views = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const response = await request(
      `views?database_id=${DATABASE}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const ref of response.results ?? []) {
      const view = await request(`views/${ref.id}`);
      if (idKey(view.data_source_id ?? "") === idKey(SOURCE)) views.push(view);
    }
    if (response.has_more === false) break;
    if (!response.next_cursor || response.next_cursor === cursor || i === 99)
      throw Error("notion-view-pagination-incomplete");
    cursor = response.next_cursor;
  }
  const again = await request(`pages/${id}`);
  if (again.last_edited_time !== page.last_edited_time)
    throw Error("notion-changed-during-structured-read");
  const title = Object.values(page.properties)
    .find((p) => p.type === "title")
    ?.title.map((t) => t.plain_text ?? t.text?.content ?? "")
    .join("");
  if (typeof title !== "string") throw Error("notion-title-missing");
  return {
    version: page.last_edited_time,
    content: semantic({
      title,
      blocks,
      properties: page.properties,
      schema: schema.properties,
      views,
    }),
    page,
  };
}
export function structuredProjection(notion, id) {
  const n = notion.content,
    mapping = mapNotionProperties(n.schema, n.properties),
    views = [],
    preservedViews = [];
  for (const raw of n.views) {
    try {
      views.push(mapNotionView(raw, mapping));
    } catch (error) {
      preservedViews.push({ id: raw.id, reason: error.message, raw });
    }
  }
  return {
    doc: {
      title: n.title,
      body: n.blocks
        .map((b) =>
          (b[b.type]?.rich_text ?? [])
            .map((t) => t.plain_text ?? t.text?.content ?? "")
            .join(""),
        )
        .join("\n\n"),
      affine: notionBlocksToAffine({ id, title: n.title, blocks: n.blocks }),
    },
    properties: mapping.properties,
    values: mapping.values,
    views,
    mapping,
    preservedViews,
  };
}
/** Build per-resource reverse writes; every operation carries exact before/after content hashes. */
export function reverseStructuredPlan(local, notion, mapping) {
  const n = notion.content,
    decoded = affineToNotionOperations(local.content.doc.affine),
    operations = [];
  const currentBlocks = new Map();
  const collect = (blocks) => {
    for (const b of blocks) {
      currentBlocks.set(b.id, b);
      collect(b.children ?? []);
    }
  };
  collect(n.blocks);
  for (const op of decoded.operations) {
    const current = currentBlocks.get(op.source.id);
    if (!current) {
      if (op.method === "DELETE") continue;
      throw Error("notion-block-disappeared");
    }
    const after =
      op.method === "DELETE"
        ? null
        : blockContent({
            ...current,
            [current.type]: {
              ...current[current.type],
              ...op.body[current.type],
            },
          });
    operations.push({
      ...op,
      target: "block",
      id: current.id,
      before: fingerprint(blockContent(current)),
      after: fingerprint(after),
    });
  }
  const currentMapping = mapNotionProperties(n.schema, n.properties);
  const properties = unmapNotionProperties(local.content.values, mapping);
  const titleProperty = Object.values(n.properties).find(
    (p) => p.type === "title",
  );
  const localTitleKey = Object.entries(mapping.bindings).find(
    ([, b]) => b.definition.type === "title",
  )?.[0];
  const titleFromRow = localTitleKey
    ? local.content.values[localTitleKey]
    : decoded.title;
  if (decoded.title !== titleFromRow)
    throw Error("notion-document-and-row-title-conflict");
  const originalTitle =
    mapping.docTitle ?? mapping.bindings[localTitleKey]?.local ?? n.title;
  if (
    decoded.title !== originalTitle &&
    titleFromRow !== mapping.bindings[localTitleKey]?.local &&
    decoded.title !== titleFromRow
  )
    throw Error("notion-title-conflicts-with-row");
  if (decoded.title !== originalTitle && decoded.title !== n.title)
    properties[titleProperty.id] = {
      title: [{ type: "text", text: { content: decoded.title } }],
    };
  if (Object.keys(properties).length) {
    const after = clone(n.properties);
    for (const [prop, patch] of Object.entries(properties)) {
      const entry = Object.entries(after).find(([, v]) => v.id === prop);
      if (!entry) throw Error("notion-property-disappeared");
      after[entry[0]] = { ...entry[1], ...patch };
    }
    operations.push({
      target: "properties",
      propertyIds: Object.keys(properties),
      body: { properties },
      before: fingerprint(
        selectedProperties(n.properties, Object.keys(properties)),
      ),
      after: fingerprint(selectedProperties(after, Object.keys(properties))),
    });
  }
  for (const localView of local.content.views) {
    const raw = n.views.find((v) => v.id === localView.id),
      baseline = mapping.views?.find((v) => v.id === localView.id);
    if (!raw && localView.id === "default" && !mapping.views?.length) continue;
    if (!raw || !baseline) throw Error("notion-view-addition-needs-review");
    const patch = unmapNotionView(localView, baseline, raw, currentMapping);
    if (Object.keys(patch).length)
      operations.push({
        target: "view",
        id: raw.id,
        body: patch,
        before: fingerprint(semantic(raw)),
        after: fingerprint(semantic({ ...raw, ...patch })),
      });
  }
  if (
    local.content.views.filter((v) => v.id !== "default").length !==
    (mapping.views ?? []).filter((v) => v.id !== "default").length
  )
    throw Error("notion-view-deletion-needs-review");
  return operations;
}
