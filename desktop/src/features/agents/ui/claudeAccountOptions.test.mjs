import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeAccountOptions,
  CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE,
  claudeAccountIdFromSelection,
  claudeAccountSelectionValue,
  DEFAULT_CLAUDE_ACCOUNT_VALUE,
  hasManualClaudeToken,
  resolveClaudeAccountLabel,
  resolveClaudeAccountUpdate,
} from "./claudeAccountOptions.ts";

const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

const ACCOUNTS = [
  {
    id: "acct-work",
    label: "Work",
    createdAt: "2026-09-01T00:00:00Z",
    tokenHint: "…ab12",
  },
  {
    id: "acct-home",
    label: "Home",
    createdAt: "2026-09-02T00:00:00Z",
    tokenHint: "…cd34",
  },
];

test("hasManualClaudeToken: only a non-blank value under the runtime's token key counts", () => {
  assert.equal(hasManualClaudeToken({}, TOKEN_ENV), false);
  assert.equal(hasManualClaudeToken({ [TOKEN_ENV]: "   " }, TOKEN_ENV), false);
  assert.equal(
    hasManualClaudeToken({ [TOKEN_ENV]: "sk-ant-x" }, TOKEN_ENV),
    true,
  );
  assert.equal(
    hasManualClaudeToken({ [TOKEN_ENV]: "sk-ant-x" }, null),
    false,
    "a runtime without a token key never reads one",
  );
});

test("options: no accounts and no manual token → Default only", () => {
  const options = buildClaudeAccountOptions({
    accounts: [],
    currentAccountId: null,
    hasManualToken: false,
  });
  assert.deepEqual(
    options.map((o) => o.value),
    [DEFAULT_CLAUDE_ACCOUNT_VALUE],
  );
  assert.equal(options[0].label, "Default (app login)");
});

test("options: accounts follow Default, in store order, labelled by account label", () => {
  const options = buildClaudeAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: null,
    hasManualToken: false,
  });
  assert.deepEqual(
    options.map((o) => [o.value, o.label]),
    [
      [DEFAULT_CLAUDE_ACCOUNT_VALUE, "Default (app login)"],
      ["acct-work", "Work"],
      ["acct-home", "Home"],
    ],
  );
});

test("options: a manual env var replaces Default with Custom (env var)", () => {
  const options = buildClaudeAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: null,
    hasManualToken: true,
  });
  assert.equal(options[0].value, CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE);
  assert.equal(options[0].label, "Custom (env var)");
  assert.ok(!options.some((o) => o.value === DEFAULT_CLAUDE_ACCOUNT_VALUE));
});

test("options: an account id the store no longer lists still renders, flagged", () => {
  const options = buildClaudeAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: "acct-gone",
    hasManualToken: false,
  });
  const gone = options.find((o) => o.value === "acct-gone");
  assert.ok(gone, "current selection must be representable");
  assert.match(gone.label, /removed/i);
});

test("selection value: account id wins, then Custom when a manual token exists, else Default", () => {
  assert.equal(
    claudeAccountSelectionValue({
      currentAccountId: "acct-work",
      hasManualToken: true,
    }),
    "acct-work",
  );
  assert.equal(
    claudeAccountSelectionValue({
      currentAccountId: null,
      hasManualToken: true,
    }),
    CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE,
  );
  assert.equal(
    claudeAccountSelectionValue({
      currentAccountId: null,
      hasManualToken: false,
    }),
    DEFAULT_CLAUDE_ACCOUNT_VALUE,
  );
});

test("claudeAccountIdFromSelection: both sentinels mean 'no stored account'", () => {
  assert.equal(
    claudeAccountIdFromSelection(DEFAULT_CLAUDE_ACCOUNT_VALUE),
    null,
  );
  assert.equal(
    claudeAccountIdFromSelection(CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE),
    null,
  );
  assert.equal(claudeAccountIdFromSelection("acct-work"), "acct-work");
});

test("submit contract: untouched → absent; Default or Custom → null; account → id", () => {
  // Untouched: same account re-selected sends nothing.
  assert.equal(
    resolveClaudeAccountUpdate({
      selectionValue: "acct-work",
      initialAccountId: "acct-work",
    }),
    undefined,
  );
  // Default on an agent that had no account: nothing to write.
  assert.equal(
    resolveClaudeAccountUpdate({
      selectionValue: DEFAULT_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: null,
    }),
    undefined,
  );
  // Back to Default from an account: explicit clear.
  assert.equal(
    resolveClaudeAccountUpdate({
      selectionValue: DEFAULT_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: "acct-work",
    }),
    null,
  );
  // Custom (env var) from an account: clear the id, the env var stays as-is.
  assert.equal(
    resolveClaudeAccountUpdate({
      selectionValue: CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: "acct-work",
    }),
    null,
  );
  // Picking an account: set.
  assert.equal(
    resolveClaudeAccountUpdate({
      selectionValue: "acct-home",
      initialAccountId: null,
    }),
    "acct-home",
  );
});

test("row label: account label when known, 'Removed account' when not, nothing without an account", () => {
  assert.equal(resolveClaudeAccountLabel("acct-work", ACCOUNTS), "Work");
  assert.equal(
    resolveClaudeAccountLabel("acct-gone", ACCOUNTS),
    "Removed account",
  );
  assert.equal(resolveClaudeAccountLabel(null, ACCOUNTS), null);
});

// ── list not available yet (loading / failed) ────────────────────────────────

import {
  findRuntimeForCommand,
  resolveClaudeAccountSubmission,
} from "./claudeAccountOptions.ts";

test("options: while the list is unknown the current account renders as pending, never as removed", () => {
  const options = buildClaudeAccountOptions({
    accounts: null,
    currentAccountId: "acct-work",
    hasManualToken: false,
  });
  const current = options.find((o) => o.value === "acct-work");
  assert.ok(current, "the saved selection must stay representable");
  assert.doesNotMatch(current.label, /removed/i);
});

test("row label: unknown list → no label (not 'Removed account')", () => {
  assert.equal(resolveClaudeAccountLabel("acct-work", null), null);
});

test("submission: runtime stopped reading a token → clear a stored account, once the runtime is known", () => {
  // Claude → Codex with an account set: the id would otherwise linger and the
  // row would keep showing "Claude account: Work" on a Codex agent.
  assert.equal(
    resolveClaudeAccountSubmission({
      tokenEnvVar: null,
      runtimeKnown: true,
      selectionValue: DEFAULT_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: "acct-work",
    }),
    null,
  );
  // Catalog not loaded yet: unknown runtime must not clear anything.
  assert.equal(
    resolveClaudeAccountSubmission({
      tokenEnvVar: null,
      runtimeKnown: false,
      selectionValue: DEFAULT_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: "acct-work",
    }),
    undefined,
  );
  // Non-token runtime and no account: nothing to send.
  assert.equal(
    resolveClaudeAccountSubmission({
      tokenEnvVar: null,
      runtimeKnown: true,
      selectionValue: DEFAULT_CLAUDE_ACCOUNT_VALUE,
      initialAccountId: null,
    }),
    undefined,
  );
  // Token runtime: same contract as resolveClaudeAccountUpdate.
  assert.equal(
    resolveClaudeAccountSubmission({
      tokenEnvVar: TOKEN_ENV,
      runtimeKnown: true,
      selectionValue: "acct-home",
      initialAccountId: null,
    }),
    "acct-home",
  );
});

test("findRuntimeForCommand: command path first, then id, else undefined", () => {
  const runtimes = [
    { id: "claude", command: "claude-agent-acp", oauthTokenEnvVar: TOKEN_ENV },
    { id: "goose", command: "goose", oauthTokenEnvVar: null },
  ];
  assert.equal(
    findRuntimeForCommand(runtimes, " claude-agent-acp ")?.id,
    "claude",
  );
  assert.equal(findRuntimeForCommand(runtimes, "goose")?.id, "goose");
  assert.equal(findRuntimeForCommand(runtimes, "cursor-agent"), undefined);
});
