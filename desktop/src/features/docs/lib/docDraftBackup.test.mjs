import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDocDraftBackup,
  docDraftBackupKey,
  readDocDraftBackup,
  writeDocDraftBackup,
} from "./docDraftBackup.ts";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    get size() {
      return map.size;
    },
  };
}

test("write → read round trip, scoped by page id", () => {
  const storage = memoryStorage();
  writeDocDraftBackup(storage, "p1", { title: "T", body: "b", savedAt: 5 });
  assert.deepEqual(readDocDraftBackup(storage, "p1"), {
    title: "T",
    body: "b",
    savedAt: 5,
  });
  assert.equal(readDocDraftBackup(storage, "p2"), null);
  assert.equal(docDraftBackupKey("p1").includes("p1"), true);
});

test("clear removes only that page's backup", () => {
  const storage = memoryStorage();
  writeDocDraftBackup(storage, "p1", { title: "", body: "one", savedAt: 1 });
  writeDocDraftBackup(storage, "p2", { title: "", body: "two", savedAt: 2 });
  clearDocDraftBackup(storage, "p1");
  assert.equal(readDocDraftBackup(storage, "p1"), null);
  assert.equal(readDocDraftBackup(storage, "p2")?.body, "two");
});

test("malformed or foreign payloads read as no backup", () => {
  const storage = memoryStorage();
  storage.setItem(docDraftBackupKey("p1"), "{not json");
  assert.equal(readDocDraftBackup(storage, "p1"), null);
  storage.setItem(docDraftBackupKey("p1"), JSON.stringify({ title: 1 }));
  assert.equal(readDocDraftBackup(storage, "p1"), null);
});

test("a storage that throws is tolerated: write reports false, read reports null", () => {
  const broken = {
    getItem: () => {
      throw new Error("quota");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(
    writeDocDraftBackup(broken, "p1", { title: "", body: "x", savedAt: 1 }),
    false,
  );
  assert.equal(readDocDraftBackup(broken, "p1"), null);
  assert.doesNotThrow(() => clearDocDraftBackup(broken, "p1"));
});
