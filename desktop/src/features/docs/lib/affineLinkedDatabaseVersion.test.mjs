import assert from "node:assert/strict";
import { test } from "node:test";
import { isAffineDocPayload } from "./docPageCodec.ts";

test("linked database snapshots use a readable version 2 envelope", () => {
  assert.equal(isAffineDocPayload({ version: 2, data: "AQID" }), true);
  assert.equal(isAffineDocPayload({ version: 1, data: "AQID" }), true);
  assert.equal(isAffineDocPayload({ version: 3, data: "AQID" }), false);
  assert.equal(isAffineDocPayload({ version: 2, data: "invalid" }), false);
});
