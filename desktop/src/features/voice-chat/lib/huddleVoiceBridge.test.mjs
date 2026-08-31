import assert from "node:assert/strict";
import test from "node:test";

import { createHuddleVoicePipelineBridge } from "./huddleVoiceBridge.ts";

function harness(overrides = {}) {
  const invoked = [];
  const interrupted = [];
  const submitted = [];
  const bridge = createHuddleVoicePipelineBridge({
    interruptSpeech: async (responseId) => {
      interrupted.push(responseId);
    },
    invoke: async (command, args) => {
      invoked.push([command, args]);
    },
    submitUtterance: async (text, turnId) => {
      submitted.push([text, turnId]);
    },
    ...overrides,
  });
  return { bridge, interrupted, invoked, submitted };
}

test("starting and stopping only toggles the existing transcription pipeline", async () => {
  const { bridge, invoked } = harness();
  await bridge.startPipeline();
  await bridge.stopPipeline();
  assert.deepEqual(invoked, [
    ["set_huddle_transcription_enabled", { enabled: true }],
    ["set_huddle_transcription_enabled", { enabled: false }],
  ]);
});

test("the microphone rides the huddle manual-unmute command", async () => {
  const { bridge, invoked } = harness();
  await bridge.setMicOpen(true);
  await bridge.setMicOpen(false);
  assert.deepEqual(invoked, [
    ["set_huddle_manual_mic_unmuted", { enabled: true }],
    ["set_huddle_manual_mic_unmuted", { enabled: false }],
  ]);
});

test("the input mode is passed through in the backend's own vocabulary", async () => {
  const { bridge, invoked } = harness();
  await bridge.setInputMode("voice_activity");
  assert.deepEqual(invoked, [
    ["set_voice_input_mode", { mode: "voice_activity" }],
  ]);
});

test("playback interruption and utterances stay with the injected host", async () => {
  const { bridge, interrupted, invoked, submitted } = harness();
  await bridge.interruptPlayback(12);
  await bridge.submitUtterance("ship it", "u1");
  assert.deepEqual(interrupted, [12]);
  assert.deepEqual(submitted, [["ship it", "u1"]]);
  assert.deepEqual(invoked, [], "no command is invented for either path");
});

test("a rejecting command surfaces to the runner instead of being swallowed", async () => {
  const { bridge } = harness({
    invoke: async () => {
      throw new Error("huddle_audio_unavailable");
    },
  });
  await assert.rejects(
    () => bridge.startPipeline(),
    /huddle_audio_unavailable/,
  );
});
