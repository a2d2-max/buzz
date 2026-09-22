import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCommunityRelays,
  classifyReconcileResult,
  pendingReconcileRelays,
  reconcileRetryDelayMs,
  RUNTIME_CAP_ERROR_CODE,
} from "./managedAgentReconciliationPlan.ts";
import { canonicalRelayUrl } from "./managedAgentRuntimeStatus.ts";

test("reconcileRetryDelayMs walks a capped backoff then gives up", () => {
  assert.equal(reconcileRetryDelayMs(1), 5_000);
  assert.equal(reconcileRetryDelayMs(2), 30_000);
  assert.equal(reconcileRetryDelayMs(3), 120_000);
  assert.equal(reconcileRetryDelayMs(4), null);
  assert.equal(reconcileRetryDelayMs(0), null);
});

test("canonicalCommunityRelays dedupes by canonical form, keeps stored spelling", () => {
  const relays = canonicalCommunityRelays(
    [
      { relayUrl: "ws://localhost:3000" },
      // Same relay, different spelling — folds onto the first entry.
      { relayUrl: "ws://127.0.0.1:3000" },
      { relayUrl: "wss://relay.example" },
      // Unparsable entries are dropped rather than reconciled.
      { relayUrl: "not a url" },
    ],
    canonicalRelayUrl,
  );
  assert.deepEqual(
    [...relays.entries()],
    [
      ["ws://127.0.0.1:3000", "ws://localhost:3000"],
      ["wss://relay.example", "wss://relay.example"],
    ],
  );
});

test("pendingReconcileRelays skips reconciled and in-flight relays", () => {
  const canonicalToRequested = new Map([
    ["ws://127.0.0.1:3000", "ws://localhost:3000"],
    ["wss://a.example", "wss://a.example"],
    ["wss://b.example", "wss://b.example"],
  ]);
  const pending = pendingReconcileRelays(
    canonicalToRequested,
    new Set(["wss://a.example"]),
    new Set(["ws://127.0.0.1:3000"]),
  );
  assert.deepEqual(pending, ["wss://b.example"]);
});

test("classifyReconcileResult marks the whole batch failed when the call throws", () => {
  const attempted = ["wss://a.example", "wss://b.example"];
  assert.deepEqual(
    classifyReconcileResult(attempted, null, canonicalRelayUrl),
    {
      succeeded: [],
      failed: attempted,
    },
  );
});

test("classifyReconcileResult splits by Failed rows, matching on requested URL", () => {
  const attempted = ["ws://127.0.0.1:3000", "wss://b.example"];
  const rows = [
    // Started cleanly on the loopback relay — reconciled.
    {
      pubkey: "aa",
      relayUrl: "ws://127.0.0.1:3000",
      requestedRelayUrl: "ws://localhost:3000",
      localSetup: true,
      lifecycle: "starting",
      pid: 1,
      error: null,
      logPath: null,
    },
    // Failed on b.example — stays failing so it is retried.
    {
      pubkey: "aa",
      relayUrl: "wss://b.example",
      requestedRelayUrl: "wss://b.example",
      localSetup: true,
      lifecycle: "failed",
      pid: null,
      error: "relay access probe timed out",
      logPath: null,
    },
  ];
  assert.deepEqual(
    classifyReconcileResult(attempted, rows, canonicalRelayUrl),
    {
      succeeded: ["ws://127.0.0.1:3000"],
      failed: ["wss://b.example"],
    },
  );
});

function capRefusedRow(relayUrl) {
  return {
    pubkey: "aa",
    relayUrl,
    requestedRelayUrl: relayUrl,
    localSetup: true,
    lifecycle: "failed",
    pid: null,
    error:
      "runtime cap reached (8 of 8 live) — stop another agent, or raise max_live_runtimes in agents/global-agent-config.json",
    errorCode: RUNTIME_CAP_ERROR_CODE,
    logPath: null,
  };
}

test("classifyReconcileResult does not retry cap-refused rows", () => {
  // The cap is a steady state, not a relay fault: it persists until the user
  // stops an agent or raises max_live_runtimes. Counting these rows as
  // failures starts the 5s/30s/2m ladder, which re-runs the whole reconcile
  // and re-emits dozens of identical rows forever.
  const attempted = ["wss://a.example", "wss://b.example"];
  const rows = [
    capRefusedRow("wss://a.example"),
    capRefusedRow("wss://b.example"),
  ];
  assert.deepEqual(
    classifyReconcileResult(attempted, rows, canonicalRelayUrl),
    {
      succeeded: attempted,
      failed: [],
    },
  );
});

test("classifyReconcileResult still retries a real failure alongside a cap refusal", () => {
  // The exclusion must be narrow: a genuinely unreachable relay in the same
  // batch still has to be retried.
  const attempted = ["wss://a.example", "wss://b.example"];
  const rows = [
    capRefusedRow("wss://a.example"),
    {
      pubkey: "aa",
      relayUrl: "wss://b.example",
      requestedRelayUrl: "wss://b.example",
      localSetup: true,
      lifecycle: "failed",
      pid: null,
      error: "relay access probe timed out",
      logPath: null,
    },
  ];
  assert.deepEqual(
    classifyReconcileResult(attempted, rows, canonicalRelayUrl),
    {
      succeeded: ["wss://a.example"],
      failed: ["wss://b.example"],
    },
  );
});

test("a failed row with no errorCode is still retried", () => {
  // Guards against the exclusion widening to every failure: rows that predate
  // the discriminator (or come from any other failure path) must keep their
  // retry.
  const rows = [
    {
      pubkey: "aa",
      relayUrl: "wss://a.example",
      requestedRelayUrl: "wss://a.example",
      localSetup: true,
      lifecycle: "failed",
      pid: null,
      error: "spawn failed",
      logPath: null,
    },
  ];
  assert.deepEqual(
    classifyReconcileResult(["wss://a.example"], rows, canonicalRelayUrl),
    { succeeded: [], failed: ["wss://a.example"] },
  );
});

test("classifyReconcileResult treats a relay with no rows as reconciled", () => {
  // A community with no eligible auto-start agents produces no rows; it must
  // still count as reconciled so the hook stops retrying it.
  assert.deepEqual(
    classifyReconcileResult(["wss://a.example"], [], canonicalRelayUrl),
    { succeeded: ["wss://a.example"], failed: [] },
  );
});
