import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { connect, SOURCE, idKey } from "./adapters.mjs";
import { syncPage } from "./engine.mjs";
const directory = process.argv[2];
if (!directory || process.argv[3] !== "--live")
  throw Error("Requires evidence directory and --live");
process.umask(0o077);
await fs.mkdir(directory, { recursive: true });
const api = await connect(path.resolve("../target/debug/buzz"));
const fixture = path.join(directory, "fixture.json");
let page;
try {
  page = JSON.parse(await fs.readFile(fixture, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  page = await api.request("pages", "POST", {
    parent: { type: "data_source_id", data_source_id: SOURCE },
    properties: {
      title: {
        title: [{ text: { content: "[동기화 검증] a2d2 Docs 2026-09-15" } }],
      },
    },
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { type: "text", text: { content: "Notion initial sync test." } },
          ],
        },
      },
    ],
  });
  await fs.writeFile(fixture, JSON.stringify({ id: page.id }), {
    mode: 0o600,
    flag: "wx",
  });
}
const state = path.join(directory, "state.json");
let record = {};
try {
  record = JSON.parse(await fs.readFile(state, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const io = api.pageIO(page.id, async (r) => {
  record = r;
  await fs.writeFile(state, JSON.stringify(r), { mode: 0o600 });
});
await syncPage(io, record);
let n = await api.readNotion(page.id);
await api.request(`pages/${page.id}/markdown`, "PATCH", {
  type: "update_content",
  update_content: {
    content_updates: [
      { old_str: n.rawBody, new_str: "Notion forward verification." },
    ],
  },
});
assert.equal(await syncPage(io, record), "notion-to-docs");
const d = await api.doc(idKey(page.id));
assert.ok(d.body.endsWith("Notion forward verification."));
n = await api.readNotion(page.id);
await api.publish(
  idKey(page.id),
  { title: d.title, body: `${n.prefix}Docs reverse verification.` },
  d,
);
assert.equal(await syncPage(io, record), "docs-to-notion");
n = await api.readNotion(page.id);
assert.equal(n.rawBody.trimEnd(), "Docs reverse verification.");
assert.equal(await syncPage(io, record), "unchanged");
const evidence = {
  pageId: page.id,
  notionToDocs: true,
  docsToNotion: true,
  noEcho: true,
  verifiedAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(directory, "result.json"),
  JSON.stringify(evidence),
  { mode: 0o600 },
);
console.log(JSON.stringify(evidence));
