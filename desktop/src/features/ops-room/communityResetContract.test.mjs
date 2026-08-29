import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const communityInitSource = await readFile(
  new URL("../communities/useCommunityInit.ts", import.meta.url),
  "utf8",
);

test("the canonical community reset inventory tears down the Ops watcher singleton", () => {
  assert.match(
    communityInitSource,
    /import \{ resetOpsWatchManager \} from "@\/features\/ops-room\/opsWatchManager";/,
  );
  const resetInventory = communityInitSource.slice(
    communityInitSource.indexOf("async function resetCommunityState"),
    communityInitSource.indexOf("type CommunityInitResult"),
  );
  assert.match(resetInventory, /resetOpsWatchManager\(\);/);
});
