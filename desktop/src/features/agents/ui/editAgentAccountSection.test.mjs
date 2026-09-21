import assert from "node:assert/strict";
import test from "node:test";

import { accountSectionModel } from "./editAgentAccountSection.ts";

const claude = {
  oauthTokenEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
  supportsCodexAccounts: false,
  dataHome: "none",
  accountUnsupportedReason: null,
};
const codex = {
  oauthTokenEnvVar: null,
  supportsCodexAccounts: true,
  dataHome: "codex_home",
  accountUnsupportedReason: null,
};
const hermes = {
  oauthTokenEnvVar: null,
  supportsCodexAccounts: false,
  dataHome: "hermes_profile",
  accountUnsupportedReason:
    "Hermes keeps its own sign-ins; a Buzz account can't be lent to it.",
};
const goose = {
  oauthTokenEnvVar: null,
  supportsCodexAccounts: false,
  dataHome: "none",
  accountUnsupportedReason: "Goose signs in with its own provider keys.",
};
const customNoReason = {
  oauthTokenEnvVar: null,
  supportsCodexAccounts: false,
  dataHome: "none",
  accountUnsupportedReason: null,
};

test("the section always has exactly one owner: a picker or the unsupported note", () => {
  for (const [name, runtime] of Object.entries({
    claude,
    codex,
    hermes,
    goose,
    customNoReason,
  })) {
    const model = accountSectionModel(runtime);
    const pickers = model.claudePicker || model.codexPicker;
    assert.equal(
      pickers,
      model.unsupportedReason === null,
      `${name}: pickers XOR unsupported note`,
    );
  }
});

test("Claude Code and Codex get their pickers and no note", () => {
  const c = accountSectionModel(claude);
  assert.equal(c.claudePicker, true);
  assert.equal(c.codexPicker, false);
  assert.equal(c.unsupportedReason, null);
  const x = accountSectionModel(codex);
  assert.equal(x.codexPicker, true);
  assert.equal(x.claudePicker, false);
});

test("runtimes that cannot use a Buzz account show the catalog's reason, never hide the field", () => {
  assert.equal(
    accountSectionModel(hermes).unsupportedReason,
    hermes.accountUnsupportedReason,
  );
  assert.equal(
    accountSectionModel(goose).unsupportedReason,
    goose.accountUnsupportedReason,
  );
  // A catalog entry without a reason still gets a sentence, not a blank.
  const fallback = accountSectionModel(customNoReason).unsupportedReason;
  assert.ok(fallback && /Claude Code and Codex/.test(fallback));
});

test("an unknown runtime disables the field and says why", () => {
  const model = accountSectionModel(undefined);
  assert.equal(model.claudePicker, false);
  assert.equal(model.codexPicker, false);
  assert.match(model.unsupportedReason ?? "", /runtime/i);
  assert.equal(model.memoryIsolated, false);
});

test("the memory note follows the data home, not the runtime id", () => {
  const h = accountSectionModel(hermes);
  assert.equal(h.memoryIsolated, true);
  assert.match(h.memoryNote, /Hermes profile/);
  assert.match(h.memoryNote, /separate from other agents/i);
  assert.match(h.memoryNote, /kept when you change/i);

  const x = accountSectionModel(codex);
  assert.equal(x.memoryIsolated, true);
  assert.match(x.memoryNote, /Codex home/);
  assert.match(x.memoryNote, /separate from other agents/i);

  const c = accountSectionModel(claude);
  assert.equal(c.memoryIsolated, false);
  assert.match(c.memoryNote, /shared/i);
  assert.match(c.memoryNote, /not available for this runtime yet/i);
});
