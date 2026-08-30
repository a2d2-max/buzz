import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeImmutableOpsPage } from "./opsPagedCollection.ts";

test("deduplicates an artifact page by immutable id, version, and representation", () => {
  const first = {
    id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "markdown",
    representation: "preview",
    status: "ready",
    title: "First",
    version: 1,
  };
  const secondVersion = { ...first, title: "Second version", version: 2 };

  assert.deepEqual(mergeImmutableOpsPage([first], [first, secondVersion]), [
    first,
    secondVersion,
  ]);
});
