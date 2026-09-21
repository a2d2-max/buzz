import test from "node:test";
import assert from "node:assert/strict";
import { createAsyncRecoveryJournal } from "./asyncRecoveryJournal.ts";
const a = {
  title: "A",
  body: "x".repeat(300000),
  affine: { version: 2, data: "YWFh" },
};
const b = { ...a, title: "B", affine: { version: 2, data: "YmJi" } };
test("durable large draft survives failed publish and late ACK", async () => {
  let stored = null;
  const update = async (_key, fn) => {
    stored = fn(stored);
  };
  const journal = createAsyncRecoveryJournal("key", "frame", update);
  await journal.record(a);
  const first = journal.revision;
  await journal.record(b);
  await journal.acknowledge(first, a.affine.data);
  assert.equal(JSON.parse(stored).title, "B");
  assert.equal(await journal.preview(a, first), false);
  await journal.acknowledge(journal.revision, b.affine.data);
  assert.equal(JSON.parse(stored).affine, undefined);
});
test("storage failure propagates and a subsequent retry can persist", async () => {
  let fail = false,
    stored = null;
  const journal = createAsyncRecoveryJournal(
    "key",
    "frame",
    async (_key, fn) => {
      if (fail) throw Error("quota");
      stored = fn(stored);
    },
  );
  await journal.record(a);
  fail = true;
  await assert.rejects(journal.record(b), /quota/);
  fail = false;
  assert.equal(await journal.preview(a, journal.revision), true);
  assert.equal(JSON.parse(stored).body.length, 300000);
});
test("old frame ACK cannot clear replacement frame recovery", async () => {
  let stored = null;
  const update = async (_key, fn) => {
    stored = fn(stored);
  };
  const old = createAsyncRecoveryJournal("key", "old", update);
  await old.record(a);
  const next = createAsyncRecoveryJournal("key", "new", update);
  await next.record(b);
  await old.acknowledge(1, a.affine.data);
  assert.equal(JSON.parse(stored).title, "B");
});

test("replaced frame cannot overwrite the new frame recovery", async () => {
  let stored = null;
  const update = async (_key, fn) => {
    stored = fn(stored);
  };
  const old = createAsyncRecoveryJournal("key", "old", update);
  await old.record(a);
  const next = createAsyncRecoveryJournal("key", "new", update);
  await next.record(b);
  await assert.rejects(old.record(a), /replaced/);
  assert.equal(JSON.parse(stored).title, "B");
});
