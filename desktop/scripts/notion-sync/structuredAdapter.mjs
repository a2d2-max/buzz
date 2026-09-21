import {
  storeDocBlob,
  loadDocBlob,
} from "../../src/features/docs/lib/docBlobStorage.ts";
import { RELAY } from "./adapters.mjs";
import { SOURCE, SIGNER, idKey } from "./adapters.mjs";
import { fingerprint } from "./structuredSync.mjs";
import {
  semantic,
  selectedProperties,
  blockContent,
  readStructuredNotion,
  structuredProjection,
  reverseStructuredPlan,
} from "./structuredNotion.mjs";
import {
  buildDocPageEventInput,
  parseDocPageEvent,
} from "../../src/features/docs/lib/docPageCodec.ts";
import {
  buildDatabaseSchemaEventInput,
  parseDatabaseSchemaEvent,
  databaseSchemaDTag,
} from "../../src/features/databases/lib/databaseSchemaCodec.ts";
import {
  buildDatabaseRowEventInput,
  parseDatabaseRowEvent,
  databaseRowDTag,
} from "../../src/features/databases/lib/databaseRowCodec.ts";
const specs = {
  doc: {
    kind: 30623,
    parse: parseDocPageEvent,
    build: buildDocPageEventInput,
    d: (id) => `doc:${id}`,
  },
  schema: {
    kind: 30624,
    parse: parseDatabaseSchemaEvent,
    build: buildDatabaseSchemaEventInput,
    d: databaseSchemaDTag,
  },
  row: {
    kind: 30625,
    parse: parseDatabaseRowEvent,
    build: buildDatabaseRowEventInput,
    d: databaseRowDTag,
  },
};
const uuid = (id) => {
  const h = idKey(id);
  if (!/^[0-9a-f]{32}$/i.test(h)) throw Error("notion-id-invalid");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** Production adapters shared by the explicit structured runner and live fixture checks. */
export function createStructuredAdapter({
  request,
  relay,
  pageId,
  save,
  record = {},
  databaseId = SOURCE,
}) {
  const blobIO = {
    upload: relay.upload,
    fetch: relay.fetch,
    relay: async () => RELAY,
    identity: async () => ({ pubkey: SIGNER }),
  };
  const ids = { doc: idKey(pageId), row: uuid(pageId), schema: databaseId };
  async function entity(target) {
    const spec = specs[target],
      events = await relay.query({
        kinds: [spec.kind, 30078],
        "#d": [spec.d(ids[target])],
        limit: 1000,
      });
    const valid = events.filter((e) => spec.parse(e));
    valid.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
    const event = valid[0];
    if (!event) return null;
    const parsed = spec.parse(event);
    if (parsed.unsupportedEditor)
      throw Error("structured-local-format-unsupported");
    return {
      content: JSON.parse(event.content),
      version: event.id,
      event,
      parsed,
    };
  }
  async function readNotion() {
    return readStructuredNotion(request, pageId);
  }
  async function readLocal() {
    const [doc, row, schema] = await Promise.all([
      entity("doc"),
      entity("row"),
      entity("schema"),
    ]);
    if (!doc && !row) return null;
    return {
      version: [doc?.version, row?.version, schema?.version].join(":"),
      content: {
        doc: doc
          ? await loadDocBlob(
              {
                title: doc.content.title,
                body: doc.content.body,
                affine: doc.content.affine,
              },
              blobIO,
            )
          : null,
        values: row?.content.values ?? null,
        views: schema?.content.views ?? null,
      },
      deleted: doc?.content.deleted || row?.content.deleted,
      entities: { doc, row, schema },
    };
  }
  async function plan(direction, source, destination, state) {
    if (direction === "notion") {
      if (!state.mapping) throw Error("structured-baseline-mapping-missing");
      if (source.content.doc?.affine?.version === 3)
        throw Error("structured-blob-read-adapter-required");
      return reverseStructuredPlan(source, destination, state.mapping);
    }
    const projection = structuredProjection(source, ids.doc),
      now = Date.now(),
      operations = [];
    const existing = destination?.entities ?? {
      schema: await entity("schema"),
    };
    const content = {
      schema: {
        name: "Notion",
        properties: projection.properties,
        views: projection.views.length
          ? projection.views
          : [
              {
                id: "default",
                name: "Table",
                type: "table",
                sorts: [],
                visiblePropertyIds: projection.properties.map((p) => p.id),
              },
            ],
        createdAt: existing.schema?.content.createdAt ?? now,
        updatedAt: now,
      },
      doc: {
        ...projection.doc,
        parentId: existing.doc?.content.parentId ?? null,
        order: existing.doc?.content.order ?? 0,
        createdAt: existing.doc?.content.createdAt ?? now,
        updatedAt: now,
      },
      row: {
        values: projection.values,
        docPageId: ids.doc,
        createdBy: existing.row?.content.createdBy ?? SIGNER,
        createdAt: existing.row?.content.createdAt ?? now,
        updatedAt: now,
      },
    };
    if (
      !record.n &&
      existing.schema &&
      (fingerprint(existing.schema.content.properties) !==
        fingerprint(content.schema.properties) ||
        fingerprint(existing.schema.content.views) !==
          fingerprint(content.schema.views))
    )
      throw Error("structured-existing-unmapped-schema");
    content.doc = await storeDocBlob(content.doc, blobIO);
    // Publish document first, then schema/row references. Every prefix is recoverable by durable intent.
    for (const target of ["doc", "schema", "row"]) {
      const spec = specs[target],
        input = spec.build({
          ...content[target],
          id: ids[target],
          ...(target === "row" ? { databaseId } : {}),
        });
      const normalized = JSON.parse(input.content);
      operations.push({
        target,
        content: normalized,
        before: fingerprint(existing[target]?.content ?? null),
        after: fingerprint(normalized),
      });
    }
    return operations;
  }
  async function readTarget(direction, op) {
    if (direction === "local") return entity(op.target);
    if (op.target === "block") {
      const value = await request(`blocks/${op.id}`);
      return { content: blockContent(value), version: value.last_edited_time };
    }
    if (op.target === "properties") {
      const value = await request(`pages/${pageId}`);
      return {
        content: selectedProperties(value.properties, op.propertyIds),
        version: value.last_edited_time,
      };
    }
    const value = await request(`views/${op.id}`);
    return { content: semantic(value), version: value.last_edited_time };
  }
  async function writeTarget(direction, op, version) {
    const current = await readTarget(direction, op);
    if (
      current?.version !== version ||
      fingerprint(current?.content ?? null) !== op.before
    )
      throw Error("structured-stale-destination");
    if (direction === "notion") {
      const path =
        op.target === "block"
          ? `blocks/${op.id}`
          : op.target === "properties"
            ? `pages/${pageId}`
            : `views/${op.id}`;
      await request(path, op.method ?? "PATCH", op.body);
      return;
    }
    const spec = specs[op.target],
      created_at = Math.max(
        Math.floor(Date.now() / 1000),
        (current?.event.created_at ?? 0) + 1,
      );
    if (created_at > Math.floor(Date.now() / 1000) + 60)
      throw Error("structured-relay-clock-skew");
    const input = spec.build({
      ...op.content,
      id: ids[op.target],
      ...(op.target === "row" ? { databaseId } : {}),
    });
    try {
      await relay.publish({ ...input, created_at });
    } catch (error) {
      if (!/unknown event kind/.test(error.message)) throw error;
      await relay.publish({ ...input, kind: 30078, created_at });
    }
  }
  return {
    readNotion,
    readLocal,
    plan,
    readTarget,
    writeTarget,
    save,
    async verify(n, d) {
      if (!n || !d || !d.content.doc?.affine || !d.content.values)
        throw Error("structured-readback-missing");
      const projected = structuredProjection(n, ids.doc);
      if (fingerprint(projected.values) !== fingerprint(d.content.values))
        throw Error("structured-property-readback-differs");
      // A second reverse plan must be empty after applying supported local edits.
      const mapping = record.mapping ?? {
        ...projected.mapping,
        views: projected.views,
        docTitle: d.content.doc.title,
      };
      if (
        reverseStructuredPlan(d, n, mapping).some(
          (op) => op.before !== op.after,
        )
      )
        throw Error("structured-content-readback-differs");
    },
    async mapping(n, d) {
      const p = structuredProjection(n, ids.doc);
      return {
        mapping: {
          ...p.mapping,
          views: p.views,
          docTitle: d.content.doc.title,
        },
        preservedViews: p.preservedViews.map((v) => ({
          id: v.id,
          reason: v.reason,
        })),
      };
    },
  };
}
