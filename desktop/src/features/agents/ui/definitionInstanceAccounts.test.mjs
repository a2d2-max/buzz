import assert from "node:assert/strict";
import test from "node:test";

import {
  instancesOfPersona,
  personaInstanceAccountUpdate,
} from "./definitionInstanceAccounts.ts";

const agents = [
  { pubkey: "a", personaId: "definition-a" },
  { pubkey: "b", personaId: "definition-a" },
  { pubkey: "c", personaId: "definition-b" },
];

test("definition account scope contains every linked community instance", () => {
  assert.deepEqual(
    instancesOfPersona(agents, "definition-a").map((agent) => agent.pubkey),
    ["a", "b"],
  );
  assert.deepEqual(instancesOfPersona(agents, null), []);
});

test("definition account batch preserves untouched, clear, and set", () => {
  assert.equal(
    personaInstanceAccountUpdate({
      claudeAccountId: undefined,
      codexAccountId: undefined,
    }),
    null,
  );
  assert.deepEqual(
    personaInstanceAccountUpdate({
      claudeAccountId: null,
      codexAccountId: "codex-1",
    }),
    {
      claudeAccountId: null,
      codexAccountId: "codex-1",
    },
  );
});
