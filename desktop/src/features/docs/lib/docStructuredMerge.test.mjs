import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import {
  addDocVersionHeads,
  resolveDocVersionHeads,
} from "./docStructuredMerge.ts";

const encode = (bytes) => Buffer.from(bytes).toString("base64");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64"));

function snapshot(entries, blobs = []) {
  const root = new Y.Doc();
  root.getMap("spaces").set("entry", new Y.Doc({ guid: "entry" }));
  const doc = new Y.Doc({ guid: "entry" });
  const blocks = doc.getMap("blocks");
  for (const [key, value] of entries) blocks.set(key, value);
  return {
    version: 2,
    data: encode(
      new TextEncoder().encode(
        JSON.stringify({
          entry: "entry",
          root: encode(Y.encodeStateAsUpdate(root)),
          docs: [{ id: "entry", state: encode(Y.encodeStateAsUpdate(doc)) }],
          blobs,
        }),
      ),
    ),
  };
}

function page({
  author,
  eventCreatedAt,
  affine,
  affineEpoch,
  deleted = false,
  eventKind = 30623,
}) {
  return {
    id: "page-1",
    author,
    eventId: `${eventCreatedAt}`.padStart(64, "0"),
    eventCreatedAt,
    eventKind,
    title: `metadata-${eventCreatedAt}`,
    body: `preview-${eventCreatedAt}`,
    affine,
    ...(affineEpoch ? { affineEpoch } : {}),
    parentId: null,
    order: 0,
    createdAt: 1,
    updatedAt: eventCreatedAt * 1000,
    deleted,
  };
}

function nestedState(payload) {
  const value = JSON.parse(new TextDecoder().decode(decode(payload.data)));
  const doc = new Y.Doc({ guid: "entry" });
  Y.applyUpdate(doc, decode(value.docs[0].state));
  return Object.fromEntries(doc.getMap("blocks"));
}

test("production resolver keeps LWW metadata and merges two author Yjs branches", async () => {
  const a = page({
    author: "a".repeat(64),
    eventCreatedAt: 10,
    affine: snapshot([["page:block:a", "text"]]),
  });
  const b = page({
    author: "b".repeat(64),
    eventCreatedAt: 11,
    affine: snapshot([["edgeless:shape:b", "rectangle"]]),
  });
  const resolved = await resolveDocVersionHeads([a, b], async (value) => value);
  assert.equal(resolved.eventId, b.eventId);
  assert.equal(resolved.title, b.title);
  assert.deepEqual(nestedState(resolved.affine), {
    "edgeless:shape:b": "rectangle",
    "page:block:a": "text",
  });
});

test("a restore never merges snapshots at or before the latest tombstone", async () => {
  const epoch = "11111111-1111-4111-8111-111111111111";
  const oldA = page({
    author: "a".repeat(64),
    eventCreatedAt: 10,
    affine: snapshot([["old:a", "must stay deleted"]]),
  });
  const oldB = page({
    author: "b".repeat(64),
    eventCreatedAt: 11,
    affine: snapshot([["old:b", "must stay deleted"]]),
  });
  const tombstone = page({
    author: "c".repeat(64),
    eventCreatedAt: 12,
    affine: oldB.affine,
    affineEpoch: epoch,
    deleted: true,
  });
  const restored = page({
    author: "c".repeat(64),
    eventCreatedAt: 13,
    affine: snapshot([["restored", "current"]]),
    affineEpoch: epoch,
  });
  // NIP-33 history keeps only the latest head for the restoring author's
  // coordinate, so the tombstone itself is no longer available to readers.
  const heads = addDocVersionHeads(new Map(), [
    oldA,
    oldB,
    tombstone,
    restored,
  ]);
  const resolved = await resolveDocVersionHeads(
    heads.get("page-1").values(),
    async (value) => value,
  );
  assert.deepEqual(nestedState(resolved.affine), { restored: "current" });
  assert.equal(resolved.affineEpoch, epoch);
});

test("attachment id collision makes the latest preview read-only", async () => {
  const blob = (data) => [
    { id: "same", type: "image/png", data: encode(Uint8Array.of(data)) },
  ];
  const a = page({
    author: "a".repeat(64),
    eventCreatedAt: 10,
    affine: snapshot([["a", "one"]], blob(1)),
  });
  const b = page({
    author: "b".repeat(64),
    eventCreatedAt: 11,
    affine: snapshot([["b", "two"]], blob(2)),
  });
  const resolved = await resolveDocVersionHeads([a, b], async (value) => value);
  assert.equal(resolved.eventId, b.eventId);
  assert.equal(resolved.structuredMergeConflict, true);
});

test("author/kind heads replace only their own stale coordinate", () => {
  const first = page({
    author: "a".repeat(64),
    eventCreatedAt: 10,
    affine: snapshot([["a", "first"]]),
  });
  const newer = { ...first, eventCreatedAt: 12, eventId: "f".repeat(64) };
  const other = page({
    author: "b".repeat(64),
    eventCreatedAt: 11,
    affine: snapshot([["b", "other"]]),
  });
  const heads = addDocVersionHeads(new Map(), [first, newer, other]);
  assert.equal(heads.get("page-1")?.size, 2);
  assert.deepEqual(
    [...heads.get("page-1").values()].map((value) => value.eventId).sort(),
    [newer.eventId, other.eventId].sort(),
  );
});
