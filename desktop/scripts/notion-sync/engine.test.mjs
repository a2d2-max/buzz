import assert from "node:assert/strict";
import { test } from "node:test";
import { syncPage } from "./engine.mjs";

function fixture() {
  let n = { title: "Title", body: "original", version: "n1" },
    d = null,
    record = {};
  const writes = [];
  const io = {
    async readNotion() {
      return structuredClone(n);
    },
    async readDoc() {
      return structuredClone(d);
    },
    async save(r) {
      record = structuredClone(r);
    },
    async writeDoc(next, base) {
      assert.equal(d?.version, base?.version);
      writes.push("doc");
      d = { ...next, version: `d${writes.length}` };
    },
    async writeNotion(next, base) {
      assert.equal(n.version, base.version);
      writes.push("notion");
      n = { ...next, version: `n${writes.length + 1}` };
    },
  };
  return {
    io,
    writes,
    get record() {
      return record;
    },
    set n(v) {
      n = { ...n, ...v };
    },
    set d(v) {
      d = { ...d, ...v };
    },
    get n() {
      return n;
    },
    get d() {
      return d;
    },
  };
}
test("initial copy then unchanged run does not write", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  assert.equal(f.d.body, "original");
  await syncPage(f.io, f.record);
  assert.deepEqual(f.writes, ["doc"]);
});
test("Notion update reaches Docs", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  f.n = { body: "Notion change", version: "n2" };
  await syncPage(f.io, f.record);
  assert.equal(f.d.body, "Notion change");
});
test("Docs update reaches Notion and does not echo", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  f.d = { body: "Docs change", version: "d2" };
  await syncPage(f.io, f.record);
  assert.equal(f.n.body, "Docs change");
  await syncPage(f.io, f.record);
  assert.deepEqual(f.writes, ["doc", "notion"]);
});
test("concurrent edits are preserved", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  f.n = { body: "N", version: "n2" };
  f.d = { body: "D", version: "d2" };
  assert.equal(await syncPage(f.io, f.record), "conflict");
  assert.equal(f.n.body, "N");
  assert.equal(f.d.body, "D");
  assert.equal(f.writes.length, 1);
});
test("existing different Docs cannot be adopted", async () => {
  const f = fixture();
  f.d = { title: "Another", body: "existing", version: "d1" };
  assert.equal(await syncPage(f.io, f.record), "conflict");
  assert.equal(f.writes.length, 0);
});
test("deletion never propagates", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  f.d = { deleted: true };
  assert.equal(await syncPage(f.io, f.record), "blocked");
  assert.equal(f.writes.length, 1);
});
test("crash after applied write resumes without repeating", async () => {
  const f = fixture();
  const write = f.io.writeDoc;
  f.io.writeDoc = async (...a) => {
    await write(...a);
    throw Error("crash");
  };
  await assert.rejects(syncPage(f.io, f.record));
  assert.ok(f.record.pending);
  f.io.writeDoc = write;
  await syncPage(f.io, f.record);
  assert.equal(f.writes.length, 1);
  assert.equal(f.record.pending, undefined);
});
test("new source change during ambiguous write is conflict", async () => {
  const f = fixture();
  f.io.writeDoc = async () => {
    throw Error("network");
  };
  await assert.rejects(syncPage(f.io, f.record));
  f.n = { body: "later", version: "n3" };
  assert.equal(await syncPage(f.io, f.record), "conflict");
});
test("title and body intent can resume after only body was applied", async () => {
  const f = fixture();
  await syncPage(f.io, f.record);
  f.d = { title: "New title", body: "New body", version: "d2" };
  const original = f.io.writeNotion;
  f.io.writeNotion = async (next) => {
    f.n = { body: next.body, version: "n2" };
    throw Error("interrupted after body");
  };
  await assert.rejects(syncPage(f.io, f.record));
  f.io.writeNotion = original;
  assert.equal(await syncPage(f.io, f.record), "docs-to-notion");
  assert.equal(f.n.title, "New title");
  assert.equal(f.n.body, "New body");
});
