import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import { mergeSnapshotPayloads } from "./snapshotMerge.ts";

const encode = (bytes) => Buffer.from(bytes).toString("base64");
const decode = (value) => new Uint8Array(Buffer.from(value, "base64"));

function payload({ state, blobs = [] }) {
  const root = new Y.Doc();
  root.getMap("spaces").set("entry", new Y.Doc({ guid: "entry" }));
  return {
    version: 2,
    data: encode(
      new TextEncoder().encode(
        JSON.stringify({
          entry: "entry",
          root: encode(Y.encodeStateAsUpdate(root)),
          docs: [{ id: "entry", state: encode(state) }],
          blobs,
        }),
      ),
    ),
  };
}

function read(payload) {
  return JSON.parse(new TextDecoder().decode(decode(payload.data)));
}

test("concurrent page and Edgeless changes plus independent blobs survive snapshot merge", () => {
  const base = new Y.Doc({ guid: "entry" });
  base.getMap("blocks").set("base", "shared");
  const baseline = Y.encodeStateAsUpdate(base);

  const pageBranch = new Y.Doc({ guid: "entry" });
  Y.applyUpdate(pageBranch, baseline);
  pageBranch.getMap("blocks").set("page:block:a", "page text");
  const edgelessBranch = new Y.Doc({ guid: "entry" });
  Y.applyUpdate(edgelessBranch, baseline);
  edgelessBranch.getMap("blocks").set("edgeless:shape:b", "rectangle");

  const merged = mergeSnapshotPayloads([
    payload({
      state: Y.encodeStateAsUpdate(pageBranch),
      blobs: [{ id: "image-a", type: "image/png", data: encode(Uint8Array.of(1, 2, 3)) }],
    }),
    payload({
      state: Y.encodeStateAsUpdate(edgelessBranch),
      blobs: [{ id: "image-b", type: "image/png", data: encode(Uint8Array.of(4, 5, 6)) }],
    }),
  ]);
  assert.equal(merged.version, 2);
  const snapshot = read(merged);
  const restored = new Y.Doc({ guid: "entry" });
  Y.applyUpdate(restored, decode(snapshot.docs[0].state));
  assert.deepEqual(Object.fromEntries(restored.getMap("blocks")), {
    base: "shared",
    "edgeless:shape:b": "rectangle",
    "page:block:a": "page text",
  });
  assert.deepEqual(
    snapshot.blobs.map((blob) => [blob.id, [...decode(blob.data)]]),
    [
      ["image-a", [1, 2, 3]],
      ["image-b", [4, 5, 6]],
    ],
  );
});

test("same attachment id with different bytes is refused", () => {
  const doc = new Y.Doc({ guid: "entry" });
  assert.throws(
    () =>
      mergeSnapshotPayloads([
        payload({
          state: Y.encodeStateAsUpdate(doc),
          blobs: [{ id: "same", type: "image/png", data: encode(Uint8Array.of(1)) }],
        }),
        payload({
          state: Y.encodeStateAsUpdate(doc),
          blobs: [{ id: "same", type: "image/png", data: encode(Uint8Array.of(2)) }],
        }),
      ]),
    /attachment collision/,
  );
});
