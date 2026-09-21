import assert from "node:assert/strict";
import test from "node:test";

import {
  batchOutcomeMessage,
  buildAccountAgentRoster,
  buildRosterJobs,
  groupInstanceSummary,
  guardedStartRunner,
  pruneRosterSelection,
  ROSTER_MOVE_DEFAULT_VALUE,
  ROSTER_MOVE_NONE_VALUE,
  resolveRosterMoveTarget,
  rosterMoveOptions,
  rosterMoveUpdates,
  rosterStartTargets,
  rosterStopTargets,
  rosterSummary,
  runRosterJobs,
  toggleRosterSelection,
  turnClearingStopRunner,
} from "./accountRosterModel.ts";

function agent(overrides) {
  return {
    pubkey: "a1",
    name: "Agent",
    personaId: null,
    claudeAccountId: null,
    codexAccountId: null,
    status: "stopped",
    backend: { type: "local" },
    ...overrides,
  };
}

const agents = [
  agent({
    pubkey: "k2",
    name: "Kangmin",
    personaId: "p-kangmin",
    codexAccountId: "ax",
    status: "stopped",
  }),
  agent({
    pubkey: "k1",
    name: "Kangmin",
    personaId: "p-kangmin",
    codexAccountId: "ax",
    status: "running",
  }),
  agent({
    pubkey: "o1",
    name: "Allright",
    personaId: "p-allright",
    codexAccountId: "ax",
    status: "running",
  }),
  agent({ pubkey: "z1", name: "Elsewhere", codexAccountId: "other" }),
  agent({ pubkey: "c1", name: "OnClaude", claudeAccountId: "ax" }),
];

function codexRoster() {
  return buildAccountAgentRoster({
    agents,
    provider: "codex",
    accountId: "ax",
  });
}

test("roster holds only the agents bound to this account and provider", () => {
  assert.deepEqual(
    codexRoster().map((group) => group.name),
    ["Allright", "Kangmin"],
  );
});

test("a definition's community instances fold into one line", () => {
  const [, kangmin] = codexRoster();
  assert.deepEqual(
    kangmin.instances.map((instance) => instance.pubkey),
    ["k2", "k1"],
  );
  assert.equal(kangmin.activeCount, 1);
});

test("an agent with no definition still gets its own line", () => {
  const groups = buildAccountAgentRoster({
    agents: [agent({ pubkey: "solo", name: "Solo", claudeAccountId: "ax" })],
    provider: "claude",
    accountId: "ax",
  });
  assert.deepEqual(
    groups.map((group) => group.key),
    ["agent:solo"],
  );
});

test("a claude account never lists agents bound by their codex id", () => {
  const groups = buildAccountAgentRoster({
    agents,
    provider: "claude",
    accountId: "ax",
  });
  assert.deepEqual(
    groups.map((group) => group.name),
    ["OnClaude"],
  );
});

test("moving fans one narrow patch out to every instance in the group", () => {
  assert.deepEqual(
    rosterMoveUpdates({
      groups: codexRoster(),
      selectedKeys: ["p-kangmin"],
      provider: "codex",
      currentAccountId: "ax",
      targetValue: "sangou",
    }),
    [
      { pubkey: "k2", codexAccountId: "sangou" },
      { pubkey: "k1", codexAccountId: "sangou" },
    ],
  );
});

test("moving to the default login submits a null account id", () => {
  const groups = buildAccountAgentRoster({
    agents,
    provider: "claude",
    accountId: "ax",
  });
  assert.deepEqual(
    rosterMoveUpdates({
      groups,
      selectedKeys: ["agent:c1"],
      provider: "claude",
      currentAccountId: "ax",
      targetValue: ROSTER_MOVE_DEFAULT_VALUE,
    }),
    [{ pubkey: "c1", claudeAccountId: null }],
  );
});

test("a move that changes nothing writes nothing", () => {
  const groups = codexRoster();
  const move = (overrides) =>
    rosterMoveUpdates({
      groups,
      selectedKeys: ["p-kangmin"],
      provider: "codex",
      currentAccountId: "ax",
      targetValue: "sangou",
      ...overrides,
    });
  assert.deepEqual(move({ targetValue: ROSTER_MOVE_NONE_VALUE }), []);
  assert.deepEqual(move({ targetValue: "ax" }), []);
  assert.deepEqual(move({ selectedKeys: [] }), []);
});

test("start takes the stopped records, stop takes the running ones", () => {
  const groups = codexRoster();
  const selected = ["p-kangmin", "p-allright"];
  assert.deepEqual(rosterStartTargets(groups, selected), ["k2"]);
  assert.deepEqual(rosterStopTargets(groups, selected), ["o1", "k1"]);
});

test("a remote agent is listed but is never a start or stop target", () => {
  const groups = buildAccountAgentRoster({
    agents: [
      agent({
        pubkey: "r1",
        name: "Remote",
        claudeAccountId: "ax",
        status: "not_deployed",
        backend: { type: "provider", id: "cloud", config: {} },
      }),
    ],
    provider: "claude",
    accountId: "ax",
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(rosterStartTargets(groups, ["agent:r1"]), []);
  assert.deepEqual(rosterStopTargets(groups, ["agent:r1"]), []);
});

test("a deployed remote agent is not reported as stopped", () => {
  const [deployed] = buildAccountAgentRoster({
    agents: [
      agent({
        pubkey: "r2",
        name: "Remote",
        claudeAccountId: "ax",
        status: "deployed",
        backend: { type: "provider", id: "cloud", config: {} },
      }),
    ],
    provider: "claude",
    accountId: "ax",
  });
  assert.equal(deployed.activeCount, 1);
  assert.equal(groupInstanceSummary(deployed), "1 running");
});

test("selection drops keys the roster no longer holds", () => {
  const after = buildAccountAgentRoster({
    agents: [
      agent({
        pubkey: "o1",
        name: "Allright",
        personaId: "p-allright",
        codexAccountId: "ax",
      }),
    ],
    provider: "codex",
    accountId: "ax",
  });
  assert.deepEqual(pruneRosterSelection(["p-kangmin", "p-allright"], after), [
    "p-allright",
  ]);
});

test("toggling adds then removes a key", () => {
  assert.deepEqual(toggleRosterSelection([], "p1"), ["p1"]);
  assert.deepEqual(toggleRosterSelection(["p1", "p2"], "p1"), ["p2"]);
});

test("move targets exclude the account the roster belongs to", () => {
  assert.deepEqual(
    rosterMoveOptions({
      accounts: [
        { id: "ax", label: "ax" },
        { id: "sangou", label: "sangou" },
      ],
      currentAccountId: "ax",
    }),
    [
      { value: ROSTER_MOVE_NONE_VALUE, label: "Move to…" },
      { value: ROSTER_MOVE_DEFAULT_VALUE, label: "Default (app login)" },
      { value: "sangou", label: "sangou" },
    ],
  );
});

test("an account list that has not arrived offers no move at all", () => {
  // Not `[Default]`: the owner would read that as a real choice and unbind
  // every selected agent.
  assert.equal(
    rosterMoveOptions({ accounts: null, currentAccountId: "ax" }),
    null,
  );
});

test("a target whose account was removed falls back to no move", () => {
  const options = rosterMoveOptions({
    accounts: [{ id: "sangou", label: "sangou" }],
    currentAccountId: "ax",
  });
  assert.equal(resolveRosterMoveTarget("sangou", options), "sangou");
  assert.equal(
    resolveRosterMoveTarget("deleted-account", options),
    ROSTER_MOVE_NONE_VALUE,
  );
  assert.equal(resolveRosterMoveTarget("sangou", null), ROSTER_MOVE_NONE_VALUE);
});

test("the summary counts agents on both sides, never records", () => {
  // Kangmin has two records with one running; Allright has one running. Two
  // agents are running, not three records' worth.
  assert.equal(
    rosterSummary(codexRoster()),
    "2 agents on this account · 2 running",
  );
  assert.equal(rosterSummary([]), "No agents on this account");
  assert.equal(
    rosterSummary(
      buildAccountAgentRoster({
        agents: [
          agent({ pubkey: "c1", name: "OnClaude", claudeAccountId: "ax" }),
        ],
        provider: "claude",
        accountId: "ax",
      }),
    ),
    "1 agent on this account",
  );
});

test("an agent whose records are all stopped is not counted as running", () => {
  const groups = buildAccountAgentRoster({
    agents: [
      agent({ pubkey: "s1", name: "Stopped", claudeAccountId: "ax" }),
      agent({
        pubkey: "r1",
        name: "Running",
        claudeAccountId: "ax",
        status: "running",
      }),
    ],
    provider: "claude",
    accountId: "ax",
  });
  assert.equal(rosterSummary(groups), "2 agents on this account · 1 running");
});

test("the per-line detail names how many records an action would touch", () => {
  const [allright, kangmin] = codexRoster();
  assert.equal(groupInstanceSummary(kangmin), "2 instances · 1 running");
  assert.equal(groupInstanceSummary(allright), "1 running");
});

test("a bulk result never hides a partial failure", () => {
  assert.equal(
    batchOutcomeMessage({
      verbPast: "Moved",
      verbBase: "move",
      succeeded: 2,
      failed: 0,
      firstError: null,
    }),
    "Moved 2 agents.",
  );
  assert.equal(
    batchOutcomeMessage({
      verbPast: "Moved",
      verbBase: "move",
      succeeded: 1,
      failed: 1,
      firstError: "relay refused",
    }),
    "Moved 1 agent, 1 failed — relay refused",
  );
  assert.equal(
    batchOutcomeMessage({
      verbPast: "Started",
      verbBase: "start",
      succeeded: 0,
      failed: 2,
      firstError: "no runtime",
    }),
    "Couldn't start 2 agents — no runtime",
  );
});

test("Start refuses an agent present on the relay, and never calls start", async () => {
  const started = [];
  const run = guardedStartRunner({
    // What the component passes: agentPresenceStartBlockReason(false, …).
    blockReason: (pubkey) =>
      pubkey === "present" ? "This agent is present on the relay." : undefined,
    start: async (pubkey) => {
      started.push(pubkey);
    },
  });
  await run("absent");
  await assert.rejects(() => run("present"), /present on the relay/);
  assert.deepEqual(started, ["absent"]);
});

test("Stop clears the agent's active turns, and only after the stop lands", async () => {
  const calls = [];
  const run = turnClearingStopRunner({
    stop: async (pubkey) => {
      calls.push(`stop:${pubkey}`);
    },
    clearTurns: (pubkey) => calls.push(`clear:${pubkey}`),
  });
  await run("k1");
  assert.deepEqual(calls, ["stop:k1", "clear:k1"]);
});

test("a failed stop does not clear turns the agent may still own", async () => {
  const cleared = [];
  const run = turnClearingStopRunner({
    stop: async () => {
      throw new Error("backend refused");
    },
    clearTurns: (pubkey) => cleared.push(pubkey),
  });
  await assert.rejects(() => run("k1"), /backend refused/);
  assert.deepEqual(cleared, []);
});

test("jobs are per agent, so a two-record agent counts once", async () => {
  const groups = codexRoster();
  const touched = [];
  const jobs = buildRosterJobs({
    groups,
    selectedKeys: ["p-kangmin", "p-allright"],
    targetsOf: rosterStopTargets,
    run: async (pubkey) => {
      touched.push(pubkey);
    },
  });
  // Allright has one running record, Kangmin one of two — two jobs, two
  // records touched.
  assert.equal(jobs.length, 2);
  const outcome = await runRosterJobs(jobs);
  assert.deepEqual(touched, ["o1", "k1"]);
  assert.deepEqual(outcome, { succeeded: 2, failed: 0, firstError: null });
});

test("a group with nothing to do produces no job at all", () => {
  const groups = codexRoster();
  const jobs = buildRosterJobs({
    groups,
    // Allright has no stopped record, so Start has nothing to do for it.
    selectedKeys: ["p-allright"],
    targetsOf: rosterStartTargets,
    run: async () => {},
  });
  assert.deepEqual(jobs, []);
});

test("one failing agent does not stop the rest, and is reported", async () => {
  const done = [];
  const outcome = await runRosterJobs([
    async () => {
      done.push("a");
    },
    async () => {
      throw new Error("relay refused");
    },
    async () => {
      done.push("c");
    },
  ]);
  assert.deepEqual(done, ["a", "c"]);
  assert.deepEqual(outcome, {
    succeeded: 2,
    failed: 1,
    firstError: "relay refused",
  });
  assert.equal(
    batchOutcomeMessage({ verbPast: "Stopped", verbBase: "stop", ...outcome }),
    "Stopped 2 agents, 1 failed — relay refused",
  );
});
