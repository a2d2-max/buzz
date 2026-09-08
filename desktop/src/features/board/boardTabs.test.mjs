import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BOARD_TAB, parseBoardTab } from "./boardTabs.ts";

test("parseBoardTab accepts exactly the two board tabs", () => {
  assert.equal(parseBoardTab("issues"), "issues");
  assert.equal(parseBoardTab("tasks"), "tasks");
});

test("parseBoardTab rejects unknown, mis-cased and non-string values", () => {
  for (const value of [
    "Issues",
    "board",
    "",
    undefined,
    null,
    1,
    ["issues"],
    { tab: "issues" },
  ]) {
    assert.equal(parseBoardTab(value), null, JSON.stringify(value));
  }
});

test("the default tab is itself a valid tab", () => {
  assert.equal(parseBoardTab(DEFAULT_BOARD_TAB), DEFAULT_BOARD_TAB);
});
