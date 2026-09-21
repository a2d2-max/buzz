import test from "node:test";
import assert from "node:assert/strict";
import {
  notionBlocksToAffine,
  affineToNotionOperations,
} from "./structuredBlocks.mjs";
const block = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "paragraph",
  paragraph: {
    rich_text: [
      {
        type: "text",
        text: { content: "Original" },
        annotations: { bold: true },
      },
    ],
  },
  children: [],
};
test("structured import keeps block ids and has no reverse writes on unchanged content", () => {
  const payload = notionBlocksToAffine({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Title",
    blocks: [block],
  });
  const reverse = affineToNotionOperations(payload);
  assert.equal(reverse.title, "Title");
  assert.deepEqual(reverse.operations, []);
  assert.deepEqual(reverse.source.blocks, [block]);
});
test("unsupported original blocks remain lossless and unchanged", () => {
  const opaque = {
    id: "33333333-3333-4333-8333-333333333333",
    type: "unsupported",
    unsupported: { block_type: "special" },
    children: [{ raw: "preserved" }],
  };
  const reverse = affineToNotionOperations(
    notionBlocksToAffine({ id: "id", title: "Title", blocks: [opaque] }),
  );
  assert.deepEqual(reverse.source.blocks, [opaque]);
  assert.deepEqual(reverse.operations, []);
});
