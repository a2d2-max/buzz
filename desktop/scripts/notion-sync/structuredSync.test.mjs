import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, syncStructuredEntity } from "./structuredSync.mjs";
function fixture() {
  let n = {
      content: { blocks: ["A"], properties: { n: 2 }, views: ["table"] },
      version: "n1",
    },
    d = null,
    saved = {},
    writes = 0,
    fail = false;
  const io = {
    readNotion: async () => structuredClone(n),
    readLocal: async () => structuredClone(d),
    save: async (r) => {
      saved = structuredClone(r);
    },
    plan: async (dir, source, dest) => [
      {
        before: fingerprint(dest?.content ?? null),
        after: fingerprint(source.content),
        content: source.content,
      },
    ],
    readTarget: async (dir) =>
      dir === "local" ? structuredClone(d) : structuredClone(n),
    writeTarget: async (dir, op) => {
      writes++;
      if (dir === "local") d = { content: op.content, version: "d1" };
      else n = { content: op.content, version: "n2" };
      if (fail) throw Error("lost ACK");
    },
    verify: async (a, b) => assert.deepEqual(a.content, b.content),
  };
  return {
    io,
    get saved() {
      return saved;
    },
    get writes() {
      return writes;
    },
    set fail(v) {
      fail = v;
    },
    editN() {
      n.content.properties.n = 3;
    },
    editD() {
      d.content.blocks = ["B"];
    },
  };
}
test("structured blocks properties and views reconcile both ways without echo", async () => {
  const f = fixture();
  assert.equal(await syncStructuredEntity(f.io), "notion-to-local");
  assert.equal(await syncStructuredEntity(f.io, f.saved), "unchanged");
  f.editD();
  assert.equal(await syncStructuredEntity(f.io, f.saved), "local-to-notion");
  assert.equal(await syncStructuredEntity(f.io, f.saved), "unchanged");
  assert.equal(f.writes, 2);
});
test("lost ACK resumes from readback without duplicate mutation", async () => {
  const f = fixture();
  f.fail = true;
  await assert.rejects(syncStructuredEntity(f.io), /lost ACK/);
  assert.equal(f.saved.pending.index, 0);
  f.fail = false;
  assert.equal(await syncStructuredEntity(f.io, f.saved), "notion-to-local");
  assert.equal(f.writes, 1);
});
test("simultaneous edits are held with original baseline", async () => {
  const f = fixture();
  await syncStructuredEntity(f.io);
  const before = f.saved.n;
  f.editN();
  f.editD();
  assert.equal(await syncStructuredEntity(f.io, f.saved), "conflict");
  assert.equal(f.saved.n, before);
  assert.equal(f.writes, 1);
});
