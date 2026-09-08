import assert from "node:assert/strict";
import { test } from "node:test";

import { createDesktopPublicationApi } from "./desktopPublicationAdapter.ts";

test("standalone Node can load the adapter contract but has no Tauri execution host", async () => {
  const api = createDesktopPublicationApi();
  assert.deepEqual(Object.keys(api).sort(), [
    "getCurrentRelay",
    "getCurrentSignerPubkey",
    "nowSeconds",
    "publishEvent",
    "queryDocVersions",
    "readAsset",
    "signEvent",
    "uploadAsset",
  ]);
  await assert.rejects(api.getCurrentRelay(), ReferenceError);
});
