import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInlineAccountControls,
  buildInlineAccountUpdate,
  isInlineAccountQueryBlocking,
} from "./inlineAgentAccountPicker.ts";

const runtimes = [
  {
    id: "claude",
    command: "claude-agent-acp",
    oauthTokenEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    supportsCodexAccounts: false,
  },
  {
    id: "codex",
    command: "codex-acp",
    oauthTokenEnvVar: null,
    supportsCodexAccounts: true,
  },
];

const claudeAccounts = [
  { id: "claude-work", label: "Claude Work", tokenHint: "", createdAt: "" },
];
const codexAccounts = [
  {
    id: "codex-work",
    label: "Codex Work",
    tokenHint: "",
    createdAt: "",
    authKind: "chatgpt",
  },
];

test("inline controls reuse catalog capabilities and the shared account option sources", () => {
  const claude = buildInlineAccountControls({
    agentCommand: "claude-agent-acp",
    claudeAccountId: "claude-work",
    codexAccountId: null,
    envVars: {},
    runtimes,
    claudeAccounts,
    codexAccounts,
  });
  assert.deepEqual(
    claude.map((control) => control.provider),
    ["claude"],
  );
  assert.equal(claude[0].value, "claude-work");
  assert.deepEqual(
    claude[0].options.map((option) => option.label),
    ["Default (app login)", "Claude Work"],
  );

  const codex = buildInlineAccountControls({
    agentCommand: "codex",
    claudeAccountId: null,
    codexAccountId: "codex-work",
    envVars: {},
    runtimes,
    claudeAccounts,
    codexAccounts,
  });
  assert.deepEqual(
    codex.map((control) => control.provider),
    ["codex"],
  );
  assert.equal(codex[0].options[1].label, "Codex Work");
});

test("inline selection emits one narrow update and omits unchanged choices", () => {
  assert.deepEqual(
    buildInlineAccountUpdate({
      pubkey: "agent-pubkey",
      provider: "claude",
      selectionValue: "claude-work",
      initialAccountId: null,
    }),
    { pubkey: "agent-pubkey", claudeAccountId: "claude-work" },
  );
  assert.deepEqual(
    buildInlineAccountUpdate({
      pubkey: "agent-pubkey",
      provider: "codex",
      selectionValue: "__default_claude_account__",
      initialAccountId: "codex-work",
    }),
    { pubkey: "agent-pubkey", codexAccountId: null },
  );
  assert.equal(
    buildInlineAccountUpdate({
      pubkey: "agent-pubkey",
      provider: "codex",
      selectionValue: "codex-work",
      initialAccountId: "codex-work",
    }),
    null,
  );
});

test("manual env auth uses the existing Custom option contract", () => {
  const [control] = buildInlineAccountControls({
    agentCommand: "codex-acp",
    claudeAccountId: null,
    codexAccountId: null,
    envVars: { OPENAI_API_KEY: "present" },
    runtimes,
    claudeAccounts,
    codexAccounts,
  });
  assert.equal(control.options[0].label, "Custom (env var)");
  assert.equal(control.value, control.options[0].value);
});

test("a disabled provider query cannot leave an inline selector blocked", () => {
  assert.equal(
    isInlineAccountQueryBlocking({
      enabled: false,
      isPending: true,
      isError: false,
    }),
    false,
  );
  assert.equal(
    isInlineAccountQueryBlocking({
      enabled: true,
      isPending: true,
      isError: false,
    }),
    true,
  );
});
