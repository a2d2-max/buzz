import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseLegacyCommunityApp } from "./appEntryMode.ts";

test("normal desktop launch preserves the complete Buzz shell", () => {
  assert.equal(
    shouldUseLegacyCommunityApp({
      href: "http://localhost/",
      huddleChannelId: null,
    }),
    true,
  );
});

test("the standalone RAOU workspace remains an explicit diagnostic surface", () => {
  assert.equal(
    shouldUseLegacyCommunityApp({
      href: "http://localhost/?raouPrimary=1",
      huddleChannelId: null,
    }),
    false,
  );
});

test("a huddle companion always keeps the existing Buzz application", () => {
  assert.equal(
    shouldUseLegacyCommunityApp({
      href: "http://localhost/?raouPrimary=1",
      huddleChannelId: "huddle-channel",
    }),
    true,
  );
});
