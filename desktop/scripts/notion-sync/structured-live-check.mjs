import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { connect, SOURCE, RELAY, SIGNER, idKey } from "./adapters.mjs";
import { structuredRelay } from "./structuredRelay.mjs";
import { createStructuredAdapter } from "./structuredAdapter.mjs";
import { syncStructuredEntity } from "./structuredSync.mjs";
import {
  notionBlocksToAffine,
  affineToNotionOperations,
} from "./structuredBlocks.mjs";
import {
  storeDocBlob,
  loadDocBlob,
} from "../../src/features/docs/lib/docBlobStorage.ts";
import { buildDocPageEventInput } from "../../src/features/docs/lib/docPageCodec.ts";
const require = createRequire(
  new URL("../../../docs-editor/package.json", import.meta.url),
);
const Y = require("yjs");
const directory = process.argv[2];
if (!directory || process.argv[3] !== "--live")
  throw Error("Requires evidence directory and --live");
process.umask(0o077);
await fs.mkdir(directory, { recursive: true });
const receipt = {
  started: new Date().toISOString(),
  checks: [],
  cleanup: [],
  databaseId: crypto.randomUUID(),
  blobDocId: crypto.randomUUID(),
};
const persist = () =>
  fs.writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(receipt, null, 2),
  );
await persist();
const api = await connect(path.resolve("../target/debug/buzz")),
  relay = await structuredRelay(RELAY, SIGNER);
let record = {};
const save = async (r) => {
  record = r;
  await fs.writeFile(path.join(directory, "state.json"), JSON.stringify(r));
};
const getHead = async (d) =>
  (
    await relay.query({
      kinds: [30623, 30624, 30625, 30078],
      "#d": [d],
      limit: 1000,
    })
  ).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
async function replace(head, content) {
  const at = Math.max(Math.floor(Date.now() / 1000), head.created_at + 1);
  return relay.publish({
    kind: head.kind,
    tags: head.tags.filter((t) => t[0] !== "auth"),
    content: JSON.stringify(content),
    created_at: at,
  });
}
const check = async (label) => {
  receipt.checks.push(label);
  await persist();
};
try {
  // Separate synthetic blob document verifies actual HTTP bytes + signed reference + fresh read.
  try {
    const body = "Synthetic large storage roundtrip. ".repeat(14000),
      id = receipt.blobDocId;
    const affine = notionBlocksToAffine({
      id,
      title: "Storage QA",
      blocks: [
        {
          id: crypto.randomUUID(),
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: body } }] },
          children: [],
        },
      ],
    });
    const snapshot = JSON.parse(Buffer.from(affine.data, "base64"));
    snapshot.blobs.push({
      id: "qa-attachment",
      type: "application/octet-stream",
      data: Buffer.alloc(1024 * 1024, 37).toString("base64"),
    });
    affine.data = Buffer.from(JSON.stringify(snapshot)).toString("base64");
    const original = {
      title: "[QA] Large storage",
      body,
      affine,
      parentId: null,
      order: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const io = {
      upload: relay.upload,
      fetch: relay.fetch,
      relay: async () => RELAY,
      identity: async () => ({ pubkey: SIGNER }),
    };
    const stored = await storeDocBlob(original, io);
    assert.equal(stored.affine.version, 3);
    receipt.blobReference = JSON.parse(stored.affine.data);
    await persist();
    const event = await relay.publish({
      ...buildDocPageEventInput({ id, ...stored }),
      created_at: Math.floor(Date.now() / 1000),
    });
    receipt.blobEvent = event.id;
    await persist();
    const fresh = await structuredRelay(RELAY, SIGNER);
    try {
      const events = await fresh.query({
        kinds: [30623],
        "#d": [`doc:${id}`],
        limit: 10,
      });
      const read = JSON.parse(events.find((e) => e.id === event.id).content);
      assert.deepEqual(
        await loadDocBlob(read, { ...io, fetch: fresh.fetch }),
        original,
      );
    } finally {
      fresh.close();
    }
    await check(
      "real blob upload, signed reference, fresh authenticated read and exact large document/attachment bytes",
    );
  } catch (error) {
    receipt.blobError = error.message;
    await persist();
  }
  const schema = await api.request(`data_sources/${SOURCE}`);
  const title = Object.values(schema.properties).find(
    (p) => p.type === "title",
  );
  const page = await api.request("pages", "POST", {
    parent: { type: "data_source_id", data_source_id: SOURCE },
    properties: {
      [title.id]: {
        title: [
          {
            text: {
              content: `[QA] Structured sync ${new Date().toISOString()}`,
            },
          },
        ],
      },
    },
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: "Initial structured paragraph." },
            },
          ],
        },
      },
    ],
  });
  receipt.pageId = page.id;
  await persist();
  const view = await api.request("views", "POST", {
    database_id: (await import("./adapters.mjs")).DATABASE,
    data_source_id: SOURCE,
    type: "table",
    name: "A2D2 structured QA",
  });
  receipt.viewId = view.id;
  await persist();
  const pass = () =>
    syncStructuredEntity(
      createStructuredAdapter({
        request: api.request,
        relay,
        pageId: page.id,
        databaseId: receipt.databaseId,
        record,
        save,
      }),
      record,
    );
  assert.equal(await pass(), "notion-to-local");
  await check(
    "Notion blocks properties and views imported through production Docs/Databases codecs",
  );
  assert.equal(await pass(), "unchanged");
  await check("no echo after structured import");
  const doc = await getHead(`doc:${idKey(page.id)}`),
    content = JSON.parse(doc.content),
    snapshot = JSON.parse(Buffer.from(content.affine.data, "base64"));
  const state = snapshot.docs.find((d) => d.id === snapshot.entry),
    ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(state.state, "base64"));
  const paragraph = [...ydoc.getMap("blocks").values()].find(
    (b) => b.get("sys:flavour") === "affine:paragraph",
  );
  const text = paragraph.get("prop:text");
  text.delete(0, text.length);
  text.insert(0, "Local structured reverse edit.");
  state.state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64");
  ydoc.destroy();
  content.affine.data = Buffer.from(JSON.stringify(snapshot)).toString(
    "base64",
  );
  await replace(doc, content);
  const schemaHead = await getHead(`db:${receipt.databaseId}`),
    schemaContent = JSON.parse(schemaHead.content);
  const localView = schemaContent.views.find((v) => v.id === receipt.viewId);
  if (!localView) throw Error("fixture-view-not-mapped");
  localView.name = "A2D2 structured QA renamed";
  await replace(schemaHead, schemaContent);
  const mutable = Object.entries(record.mapping.bindings).find(([, b]) =>
    ["number", "checkbox", "url", "email", "phone_number"].includes(
      b.definition.type,
    ),
  );
  if (mutable) {
    const row = await getHead(`dbrow:${page.id}`),
      rowContent = JSON.parse(row.content);
    rowContent.values[mutable[0]] = {
      number: 7,
      checkbox: true,
      url: "https://example.com/a2d2-qa",
      email: "qa@example.com",
      phone_number: "+10000000000",
    }[mutable[1].definition.type];
    await replace(row, rowContent);
  }
  assert.equal(await pass(), "local-to-notion");
  await check(
    "structured block and view edits propagated back to actual Notion API",
  );
  if (mutable)
    await check("typed property edit propagated back to actual Notion API");
  assert.equal(await pass(), "unchanged");
  await check("no echo after reverse structured sync");
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  if (receipt.viewId)
    try {
      await api.request(`views/${receipt.viewId}`, "DELETE");
      receipt.cleanup.push({ view: true });
    } catch (e) {
      receipt.cleanup.push({ viewError: e.message });
      process.exitCode = 1;
    }
  if (receipt.pageId)
    try {
      await api.request(`pages/${receipt.pageId}`, "PATCH", { in_trash: true });
      receipt.cleanup.push({ page: true });
    } catch (e) {
      receipt.cleanup.push({ pageError: e.message });
      process.exitCode = 1;
    }
  const addresses = [
    `doc:${receipt.blobDocId}`,
    `db:${receipt.databaseId}`,
    ...(receipt.pageId
      ? [`doc:${idKey(receipt.pageId)}`, `dbrow:${receipt.pageId}`]
      : []),
  ];
  for (const d of addresses)
    try {
      const head = await getHead(d);
      if (head) {
        await replace(head, {
          ...JSON.parse(head.content),
          deleted: true,
          updatedAt: Date.now(),
        });
        assert.equal(JSON.parse((await getHead(d)).content).deleted, true);
      }
      receipt.cleanup.push({ address: d, tombstoneOrAbsent: true });
    } catch (e) {
      receipt.cleanup.push({ address: d, error: e.message });
      process.exitCode = 1;
    }
  relay.close();
  receipt.finished = new Date().toISOString();
  await persist();
  console.log(
    JSON.stringify({
      status: receipt.status,
      checks: receipt.checks,
      blobError: receipt.blobError,
      error: receipt.error,
      cleanup: receipt.cleanup,
    }),
  );
}
