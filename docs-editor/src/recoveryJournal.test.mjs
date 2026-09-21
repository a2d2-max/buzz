import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryJournal } from "./recoveryJournal.ts";
function storage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
}
const a = { affine: { version: 1, data: "AQID" }, title: "A", body: "A" };
const b = { affine: { version: 1, data: "BAUG" }, title: "B", body: "B" };
test("late A save acknowledgment cannot delete B before the host receives B", () => {
  const s = storage();
  const journal = createRecoveryJournal(s, "key", "frame-one");
  journal.record(a);
  const savingRevision = journal.revision;
  journal.record(b); // immediate iframe journal, before the debounced host message
  assert.equal(journal.acknowledge(savingRevision, a.affine.data), false);
  assert.equal(JSON.parse(s.getItem("key")).affine.data, b.affine.data);
  assert.equal(journal.preview(a, savingRevision), false);
  assert.equal(JSON.parse(s.getItem("key")).affine.data, b.affine.data);
  assert.equal(journal.acknowledge(journal.revision, b.affine.data), true);
  assert.equal(s.getItem("key"), null);
});
test("an old mounted frame cannot clear a replacement frame's journal", () => {
  const s = storage();
  const old = createRecoveryJournal(s, "key", "old");
  const current = createRecoveryJournal(s, "key", "current");
  old.record(a);
  current.record(b);
  assert.equal(old.acknowledge(1, a.affine.data), false);
  assert.equal(JSON.parse(s.getItem("key")).affine.data, b.affine.data);
});
