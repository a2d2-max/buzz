import test from "node:test";
import assert from "node:assert/strict";
import { storeDocBlob, loadDocBlob } from "./docBlobStorage.ts";
import { createHash } from "node:crypto";
const page = {
  title: "Large",
  body: "body".repeat(80000),
  affine: { version: 2, data: "YWFh".repeat(60000) },
  parentId: null,
  order: 0,
  createdAt: 1,
  updatedAt: 1,
};
function setup() {
  let bytes;
  const io = {
    relay: async () => "wss://example.test",
    identity: async () => ({ pubkey: "alice" }),
    upload: async (file) => {
      bytes = new Uint8Array(await file.arrayBuffer());
      return {
        url: "https://example.test/blob",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    fetch: async () => bytes,
  };
  return io;
}
test("large state and attachment bytes survive a fresh reference load", async () => {
  const io = setup(),
    saved = await storeDocBlob(page, io);
  assert.equal(saved.affine.version, 3);
  assert.ok(JSON.stringify(saved).length < 20000);
  assert.deepEqual(
    await loadDocBlob(JSON.parse(JSON.stringify(saved)), io),
    page,
  );
});
test("upload failure and corrupt download propagate without replacing input", async () => {
  const io = setup();
  await assert.rejects(
    storeDocBlob(page, {
      ...io,
      upload: async () => {
        throw Error("offline");
      },
    }),
    /offline/,
  );
  assert.equal(page.affine.version, 2);
  const saved = await storeDocBlob(page, io);
  await assert.rejects(
    loadDocBlob(saved, { ...io, fetch: async () => new Uint8Array([1]) }),
    /integrity/,
  );
});
test("foreign blob URLs are refused before fetching", async () => {
  const io = setup(),
    saved = await storeDocBlob(page, io);
  const ref = JSON.parse(saved.affine.data);
  ref.url = "https://evil.test/blob";
  await assert.rejects(
    loadDocBlob(
      { ...saved, affine: { version: 3, data: JSON.stringify(ref) } },
      {
        ...io,
        fetch: async () => {
          assert.fail("must not fetch");
        },
      },
    ),
    /another community/,
  );
});

test("identity change during upload refuses reference publication", async () => {
  const io = setup();
  let identity = "alice";
  const upload = io.upload;
  await assert.rejects(
    storeDocBlob(page, {
      ...io,
      identity: async () => ({ pubkey: identity }),
      upload: async (file) => {
        const result = await upload(file);
        identity = "bob";
        return result;
      },
    }),
    /identity changed/,
  );
});
