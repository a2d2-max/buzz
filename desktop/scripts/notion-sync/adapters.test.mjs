import assert from "node:assert/strict";
import { test } from "node:test";
import {
  metadataPrefix,
  splitBody,
  validateMarkdown,
  assertMarkdownDoc,
} from "./adapters.mjs";
const page = {
  id: "abc-def",
  properties: {
    Title: { type: "title", title: [] },
    Status: { type: "status", status: { name: "In progress" } },
  },
};
test("empty and nonempty bodies retain immutable metadata", () => {
  const p = metadataPrefix(page);
  assert.equal(splitBody(p.trimEnd(), p), "");
  assert.equal(splitBody(`${p}new text`, p), "new text");
  assert.throws(
    () => splitBody(`${p}text`.replace("In progress", "Done"), p),
    /metadata-edited/,
  );
});
test("truncated and inaccessible content cannot overwrite a document", () => {
  assert.throws(
    () =>
      validateMarkdown({
        markdown: "partial",
        truncated: true,
        unknown_block_ids: [],
      }),
    /incomplete/,
  );
  assert.throws(
    () =>
      validateMarkdown({
        markdown: "partial",
        truncated: false,
        unknown_block_ids: ["missing"],
      }),
    /incomplete/,
  );
  assert.equal(
    validateMarkdown({
      markdown: "full\n",
      truncated: false,
      unknown_block_ids: [],
    }),
    "full",
  );
});

test("legacy synchronization holds structured documents instead of flattening them", () => {
  assert.throws(
    () => assertMarkdownDoc({ page: { affine: { version: 1, data: "AQID" } } }),
    /structured-document-needs-affine-sync/,
  );
  assert.doesNotThrow(() => assertMarkdownDoc(null));
  assert.doesNotThrow(() => assertMarkdownDoc({ page: { body: "markdown" } }));
});
