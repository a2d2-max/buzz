import test from "node:test";
import assert from "node:assert/strict";
import { prepareMigration } from "./migration.mjs";
const fixture = () => {
  const d = { title: "old", body: "body", version: "event", page: {} };
  const n = { title: "new", body: "new body", version: "2" };
  const local = {
    content: { doc: { title: "old", body: "body" } },
    entities: { doc: { version: "event" } },
  };
  const notion = { version: "2", content: { title: "new", blocks: [] } };
  const legacy = { n: { title: "old", body: "body" }, d: structuredClone(d) };
  const calls = [];
  return {
    d,
    n,
    local,
    notion,
    legacy,
    calls,
    io: {
      plan: async () => {
        calls.push("plan");
        return [{ before: "a", after: "b" }];
      },
    },
    backup: async () => calls.push("backup"),
  };
};
test("migration preserves backup before durable pending, allowing source-only changes", async () => {
  const f = fixture();
  const r = await prepareMigration(f);
  assert.equal(r.pending.direction, "local");
  assert.equal(r.pending.index, 0);
  assert.deepEqual(f.calls, ["backup", "plan"]);
});
for (const [name, change, reason] of [
  [
    "diverged baseline",
    (f) => (f.legacy.n.body = "other"),
    "legacy-baseline-diverged",
  ],
  [
    "existing row",
    (f) => (f.local.entities.row = { version: "row" }),
    "migration-existing-unmapped-row",
  ],
  ["pending", (f) => (f.legacy.pending = {}), "legacy-pending"],
  ["local edit", (f) => (f.d.body = "edited"), "legacy-local-changed"],
  ["missing baseline", (f) => (f.legacy = {}), "legacy-baseline-missing"],
  ["deleted", (f) => (f.d.deleted = true), "legacy-deleted"],
  [
    "structured source changed",
    (f) => (f.notion.version = "3"),
    "migration-source-changed",
  ],
  [
    "local head changed",
    (f) => (f.local.entities.doc.version = "new"),
    "migration-local-changed",
  ],
  [
    "already affine",
    (f) => (f.d.page.affine = {}),
    "migration-already-structured",
  ],
])
  test(name + " is held without planning writes", async () => {
    const f = fixture();
    change(f);
    await assert.rejects(prepareMigration(f), new RegExp(reason));
    assert.deepEqual(f.calls, []);
  });
test("backup failure prevents planning and publication", async () => {
  const f = fixture();
  f.backup = async () => {
    throw Error("disk-full");
  };
  await assert.rejects(prepareMigration(f), /disk-full/);
  assert.deepEqual(f.calls, []);
});
