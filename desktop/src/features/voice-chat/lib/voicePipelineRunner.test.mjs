import assert from "node:assert/strict";
import test from "node:test";

import { createVoicePipelineRunner } from "./voicePipelineRunner.ts";

/** A bridge that records every call and can be told to reject one of them. */
function fakeBridge(failing = null, error = new Error("bridge is down")) {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
      return name === failing ? Promise.reject(error) : Promise.resolve();
    };
  return {
    calls,
    interruptPlayback: record("interruptPlayback"),
    setInputMode: record("setInputMode"),
    setMicOpen: record("setMicOpen"),
    startPipeline: record("startPipeline"),
    stopPipeline: record("stopPipeline"),
    submitUtterance: record("submitUtterance"),
  };
}

function harness(failing, error) {
  const bridge = fakeBridge(failing, error);
  const dispatched = [];
  const runner = createVoicePipelineRunner(bridge, (event) =>
    dispatched.push(event),
  );
  return { bridge, dispatched, runner };
}

test("every effect maps onto one pipeline call", async () => {
  const { bridge, runner } = harness();
  await runner.run([
    { type: "start-pipeline" },
    { mode: "push_to_talk", type: "set-input-mode" },
    { open: true, type: "set-mic-open" },
    { text: "hello", turnId: "u1", type: "submit-utterance" },
    { responseId: 4, type: "stop-playback" },
    { type: "stop-pipeline" },
  ]);
  assert.deepEqual(bridge.calls, [
    ["startPipeline"],
    ["setInputMode", "push_to_talk"],
    ["setMicOpen", true],
    ["submitUtterance", "hello", "u1"],
    ["interruptPlayback", 4],
    ["stopPipeline"],
  ]);
});

test("hands-free is translated to the huddle voice-activity mode", async () => {
  const { bridge, runner } = harness();
  await runner.run([{ mode: "hands_free", type: "set-input-mode" }]);
  assert.deepEqual(bridge.calls, [["setInputMode", "voice_activity"]]);
});

test("a started pipeline reports itself ready", async () => {
  const { dispatched, runner } = harness();
  await runner.run([{ type: "start-pipeline" }]);
  assert.deepEqual(dispatched, [{ type: "session/ready" }]);
});

test("effects run in order even when they are queued separately", async () => {
  const { bridge, runner } = harness();
  const first = runner.run([{ responseId: 1, type: "stop-playback" }]);
  const second = runner.run([{ open: false, type: "set-mic-open" }]);
  await Promise.all([first, second]);
  assert.deepEqual(bridge.calls, [
    ["interruptPlayback", 1],
    ["setMicOpen", false],
  ]);
});

test("a failing call becomes a retryable error instead of a rejection", async () => {
  const { dispatched, runner } = harness(
    "startPipeline",
    new Error("no audio"),
  );
  await runner.run([{ type: "start-pipeline" }]);
  assert.deepEqual(dispatched, [
    {
      error: { code: "pipeline_unavailable", message: "no audio" },
      type: "error",
    },
  ]);
});

test("each failing effect reports the code its surface owns", async () => {
  const cases = [
    ["setMicOpen", { open: true, type: "set-mic-open" }, "mic_unavailable"],
    [
      "submitUtterance",
      { text: "hi", turnId: "u1", type: "submit-utterance" },
      "assistant_failed",
    ],
    [
      "interruptPlayback",
      { responseId: 2, type: "stop-playback" },
      "tts_failed",
    ],
  ];
  for (const [failing, effect, code] of cases) {
    const { dispatched, runner } = harness(failing);
    await runner.run([effect]);
    assert.equal(
      dispatched.at(0)?.error?.code,
      code,
      `${effect.type} -> ${code}`,
    );
  }
});

test("a failed effect stops the rest of its batch", async () => {
  const { bridge, dispatched, runner } = harness("setMicOpen");
  await runner.run([
    { open: true, type: "set-mic-open" },
    { text: "hi", turnId: "u1", type: "submit-utterance" },
  ]);
  assert.deepEqual(bridge.calls, [["setMicOpen", true]]);
  assert.equal(dispatched.length, 1);
});

test("a later batch still runs after an earlier one failed", async () => {
  const { bridge, runner } = harness("setMicOpen");
  await runner.run([{ open: true, type: "set-mic-open" }]);
  await runner.run([{ type: "stop-pipeline" }]);
  assert.deepEqual(bridge.calls.at(-1), ["stopPipeline"]);
});

test("stopping the pipeline is best-effort and never raises an error state", async () => {
  const { dispatched, runner } = harness("stopPipeline");
  await runner.run([{ type: "stop-pipeline" }]);
  assert.deepEqual(dispatched, [], "teardown failure must not block a close");
});

test("a disposed runner drops effects it has not started yet", async () => {
  const { bridge, runner } = harness();
  runner.dispose();
  await runner.run([{ type: "start-pipeline" }]);
  assert.deepEqual(bridge.calls, []);
});

test("an empty batch touches nothing", async () => {
  const { bridge, dispatched, runner } = harness();
  await runner.run([]);
  assert.deepEqual(bridge.calls, []);
  assert.deepEqual(dispatched, []);
});
