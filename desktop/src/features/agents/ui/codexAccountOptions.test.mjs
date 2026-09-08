import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexAccountOptions,
  codexAccountIdFromSelection,
  codexAccountSelectionValue,
  hasManualCodexAuth,
  resolveCodexAccountLabel,
  resolveCodexAccountSubmission,
} from "./codexAccountOptions.ts";

const ACCOUNTS = [
  {
    id: "acct-work",
    label: "Work",
    createdAt: "2026-09-01T00:00:00Z",
    tokenHint: "…ab12",
    authKind: "api_key",
  },
  {
    id: "acct-team",
    label: "Team",
    createdAt: "2026-09-02T00:00:00Z",
    tokenHint: "",
    authKind: "chatgpt",
  },
];

test("hasManualCodexAuth: either Codex login env var counts, blanks do not", () => {
  assert.equal(hasManualCodexAuth({}), false);
  assert.equal(hasManualCodexAuth({ OPENAI_API_KEY: "   " }), false);
  assert.equal(hasManualCodexAuth({ CODEX_HOME: "" }), false);
  assert.equal(hasManualCodexAuth({ OPENAI_API_KEY: "sk-x" }), true);
  assert.equal(hasManualCodexAuth({ CODEX_HOME: "/somewhere" }), true);
  assert.equal(
    hasManualCodexAuth({ UNRELATED: "x", OPENAI_API_KEEY: "typo" }),
    false,
    "only the exact Codex login keys count",
  );
});

test("options and selection: the shared machinery drives the Codex picker", () => {
  // Default synthetic entry plus the stored accounts, in order.
  const options = buildCodexAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: null,
    hasManualToken: false,
  });
  assert.deepEqual(
    options.map((option) => option.label),
    ["Default (app login)", "Work", "Team"],
  );

  // Manual env auth replaces Default with Custom; both submit as null.
  const custom = buildCodexAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: null,
    hasManualToken: true,
  });
  assert.equal(custom[0].label, "Custom (env var)");
  for (const synthetic of [options[0].value, custom[0].value]) {
    assert.equal(codexAccountIdFromSelection(synthetic), null);
  }
  assert.equal(codexAccountIdFromSelection("acct-work"), "acct-work");

  // A saved selection stays representable while the list is unknown.
  const pending = buildCodexAccountOptions({
    accounts: null,
    currentAccountId: "acct-gone",
    hasManualToken: false,
  });
  assert.equal(pending.at(-1)?.label, "Loading account…");
  const removed = buildCodexAccountOptions({
    accounts: ACCOUNTS,
    currentAccountId: "acct-gone",
    hasManualToken: false,
  });
  assert.equal(removed.at(-1)?.label, "Removed account");

  // Selection value mirrors the Claude picker's contract.
  assert.equal(
    codexAccountSelectionValue({
      currentAccountId: "acct-work",
      hasManualToken: true,
    }),
    "acct-work",
  );
});

test("resolveCodexAccountSubmission: gated on the runtime capability", () => {
  const base = {
    selectionValue: "acct-work",
    initialAccountId: null,
  };

  // Supported runtime: the change is submitted; no change submits nothing.
  assert.equal(
    resolveCodexAccountSubmission({
      ...base,
      supportsCodexAccounts: true,
      runtimeKnown: true,
    }),
    "acct-work",
  );
  assert.equal(
    resolveCodexAccountSubmission({
      supportsCodexAccounts: true,
      runtimeKnown: true,
      selectionValue: "acct-work",
      initialAccountId: "acct-work",
    }),
    undefined,
  );

  // Unsupported runtime: a stored account is cleared — but only once the
  // catalog has actually said what the runtime is.
  assert.equal(
    resolveCodexAccountSubmission({
      supportsCodexAccounts: false,
      runtimeKnown: true,
      selectionValue: "acct-work",
      initialAccountId: "acct-work",
    }),
    null,
  );
  assert.equal(
    resolveCodexAccountSubmission({
      supportsCodexAccounts: false,
      runtimeKnown: false,
      selectionValue: "acct-work",
      initialAccountId: "acct-work",
    }),
    undefined,
    "an unloaded catalog must never turn into a destructive write",
  );
  assert.equal(
    resolveCodexAccountSubmission({
      supportsCodexAccounts: false,
      runtimeKnown: true,
      selectionValue: "acct-work",
      initialAccountId: null,
    }),
    undefined,
  );
});

test("resolveCodexAccountLabel: label for the row, null for app login/unknown list", () => {
  assert.equal(resolveCodexAccountLabel(null, ACCOUNTS), null);
  assert.equal(resolveCodexAccountLabel("acct-team", null), null);
  assert.equal(resolveCodexAccountLabel("acct-team", ACCOUNTS), "Team");
  assert.equal(
    resolveCodexAccountLabel("acct-gone", ACCOUNTS),
    "Removed account",
  );
});
