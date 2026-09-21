import assert from "node:assert/strict";
import test from "node:test";

import { addClaudeAccountAndLoadLoginCommand } from "./addClaudeAccountFlow.ts";

test("a failed login-command lookup preserves the successfully added account for retry", async () => {
  let addCalls = 0;
  const result = await addClaudeAccountAndLoadLoginCommand(
    { label: "Work", authKind: "config_dir" },
    async () => {
      addCalls += 1;
      return {
        id: "saved-account",
        label: "Work",
        createdAt: "2026-09-09T00:00:00Z",
        tokenHint: "",
        authKind: "config_dir",
      };
    },
    async () => {
      throw new Error("temporary lookup failure");
    },
  );

  assert.equal(addCalls, 1);
  assert.equal(result.account.id, "saved-account");
  assert.equal(result.loginCommand, null);
  assert.equal(result.loginCommandError, "temporary lookup failure");
});
