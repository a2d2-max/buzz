import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceConversationState,
  isMicOpen,
  reduceVoiceConversation,
} from "./voiceConversationMachine.ts";

/** Drive a list of events through the reducer, collecting every effect. */
function run(events, initial = createVoiceConversationState()) {
  let state = initial;
  const effects = [];
  for (const event of events) {
    const next = reduceVoiceConversation(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const opened = [{ type: "session/open" }, { type: "session/ready" }];

test("a closed session starts idle with a closed microphone", () => {
  const state = createVoiceConversationState();
  assert.equal(state.status, "idle");
  assert.equal(isMicOpen(state), false);
  assert.equal(state.inputMode, "push_to_talk");
  assert.deepEqual(state.turns, []);
});

test("opening a session starts the pipeline and lands in listening", () => {
  const { state, effects } = run(opened);
  assert.equal(state.status, "listening");
  assert.deepEqual(
    effects.filter((effect) => effect.type === "start-pipeline"),
    [{ type: "start-pipeline" }],
  );
});

test("push-to-talk keeps the microphone closed until the key is held", () => {
  const held = run([...opened, { type: "ptt/press" }]);
  assert.equal(held.state.status, "capturing");
  assert.equal(isMicOpen(held.state), true);
  assert.deepEqual(held.effects.at(-1), { type: "set-mic-open", open: true });

  const released = run([{ type: "ptt/release" }], held.state);
  assert.equal(released.state.status, "listening");
  assert.equal(isMicOpen(released.state), false);
  assert.deepEqual(released.effects.at(-1), {
    type: "set-mic-open",
    open: false,
  });
});

test("hands-free opens the microphone as soon as the session is ready", () => {
  const { state, effects } = run([
    { type: "input-mode/set", mode: "hands_free" },
    ...opened,
  ]);
  assert.equal(isMicOpen(state), true);
  assert.ok(
    effects.some(
      (effect) =>
        effect.type === "set-input-mode" && effect.mode === "hands_free",
    ),
    "the pipeline is told about the mode change",
  );
});

test("a held push-to-talk key temporarily opens a manually muted microphone", () => {
  const muted = run([...opened, { type: "mic/set-muted", muted: true }]);
  assert.equal(isMicOpen(muted.state), false);

  const held = run([{ type: "ptt/press" }], muted.state);
  assert.equal(isMicOpen(held.state), true, "matches the huddle mute rule");

  const handsFree = run(
    [{ type: "input-mode/set", mode: "hands_free" }],
    muted.state,
  );
  assert.equal(
    isMicOpen(handsFree.state),
    false,
    "hands-free never overrides a manual mute",
  );
});

test("partial transcripts stream into the live transcript slot", () => {
  const { state } = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/partial", text: "what is" },
    { type: "transcript/partial", text: "what is the plan" },
  ]);
  assert.deepEqual(state.liveTranscript, {
    isFinal: false,
    text: "what is the plan",
  });
  assert.equal(state.status, "capturing");
});

test("a partial transcript starts capture in hands-free mode", () => {
  const { state } = run([
    { type: "input-mode/set", mode: "hands_free" },
    ...opened,
    { type: "transcript/partial", text: "hey" },
  ]);
  assert.equal(state.status, "capturing");
});

test("a final transcript records the user turn and submits it once", () => {
  const { state, effects } = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/partial", text: "draft" },
    { type: "transcript/final", text: "ship the release", turnId: "u1" },
  ]);
  assert.equal(state.status, "thinking");
  assert.equal(state.liveTranscript, null);
  assert.deepEqual(state.turns, [
    { id: "u1", interrupted: false, role: "user", text: "ship the release" },
  ]);
  assert.deepEqual(
    effects.filter((effect) => effect.type === "submit-utterance"),
    [{ type: "submit-utterance", text: "ship the release", turnId: "u1" }],
  );
});

test("an empty final transcript returns to listening without submitting", () => {
  const { state, effects } = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "   ", turnId: "u1" },
  ]);
  assert.equal(state.status, "listening");
  assert.deepEqual(state.turns, []);
  assert.equal(
    effects.some((effect) => effect.type === "submit-utterance"),
    false,
  );
});

test("assistant streaming and playback run through their full lifecycle", () => {
  const { state } = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 7 },
    { type: "assistant/stream-delta", text: "Hi " },
    { type: "playback/started" },
    { type: "assistant/stream-delta", text: "there." },
    { type: "assistant/stream-end" },
  ]);
  assert.equal(state.status, "responding");
  assert.equal(state.assistantDraft, "Hi there.");
  assert.equal(state.assistantPlayback, "speaking");

  const ended = run([{ type: "playback/ended" }], state);
  assert.equal(ended.state.status, "listening");
  assert.equal(ended.state.assistantPlayback, "idle");
  assert.deepEqual(ended.state.turns.at(-1), {
    id: "a7",
    interrupted: false,
    role: "assistant",
    text: "Hi there.",
  });
});

test("barge-in stops playback and reopens capture mid-response", () => {
  const responding = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 7 },
    { type: "assistant/stream-delta", text: "Let me explain" },
    { type: "playback/started" },
  ]);
  assert.equal(responding.state.status, "responding");

  const bargedIn = run([{ type: "ptt/press" }], responding.state);
  assert.deepEqual(
    bargedIn.effects.filter((effect) => effect.type === "stop-playback"),
    [{ type: "stop-playback", responseId: 7 }],
  );
  assert.equal(bargedIn.state.status, "capturing");
  assert.equal(bargedIn.state.assistantPlayback, "interrupted");
  assert.deepEqual(bargedIn.state.turns.at(-1), {
    id: "a7",
    interrupted: true,
    role: "assistant",
    text: "Let me explain",
  });
});

test("hands-free speech detection barges in the same way", () => {
  const responding = run([
    { type: "input-mode/set", mode: "hands_free" },
    ...opened,
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 2 },
    { type: "assistant/stream-delta", text: "Sure" },
    { type: "playback/started" },
  ]);
  const bargedIn = run([{ type: "speech/detected" }], responding.state);
  assert.equal(bargedIn.state.status, "capturing");
  assert.ok(
    bargedIn.effects.some((effect) => effect.type === "stop-playback"),
    "playback is cancelled before the user is captured",
  );
});

test("late deltas from an interrupted response are ignored", () => {
  const responding = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 3 },
    { type: "assistant/stream-delta", text: "partial" },
    { type: "playback/started" },
    { type: "ptt/press" },
  ]);
  const late = run(
    [
      { type: "assistant/stream-delta", text: " more" },
      { type: "playback/ended" },
    ],
    responding.state,
  );
  assert.equal(late.state.assistantDraft, "");
  assert.equal(late.state.status, "capturing");
  assert.equal(
    late.state.turns.filter((turn) => turn.role === "assistant").length,
    1,
  );
});

test("muting mid-capture drops the partial transcript and closes the mic", () => {
  const capturing = run([
    { type: "input-mode/set", mode: "hands_free" },
    ...opened,
    { type: "transcript/partial", text: "half a sentence" },
  ]);
  const muted = run([{ type: "mic/set-muted", muted: true }], capturing.state);
  assert.equal(muted.state.status, "listening");
  assert.equal(muted.state.liveTranscript, null);
  assert.equal(isMicOpen(muted.state), false);
  assert.deepEqual(muted.effects.at(-1), { type: "set-mic-open", open: false });
});

test("an error is retryable and clears on retry", () => {
  const failed = run([
    ...opened,
    {
      type: "error",
      error: {
        code: "pipeline_unavailable",
        message: "Voice pipeline stopped",
      },
    },
  ]);
  assert.equal(failed.state.status, "error");
  assert.equal(failed.state.error?.code, "pipeline_unavailable");
  assert.equal(isMicOpen(failed.state), false);

  const retried = run([{ type: "retry" }], failed.state);
  assert.equal(retried.state.status, "connecting");
  assert.equal(retried.state.error, null);
  assert.deepEqual(retried.effects.at(0), { type: "start-pipeline" });
});

test("an error mid-response cancels playback", () => {
  const responding = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 5 },
    { type: "playback/started" },
  ]);
  const failed = run(
    [
      {
        type: "error",
        error: { code: "tts_failed", message: "Playback failed" },
      },
    ],
    responding.state,
  );
  assert.ok(failed.effects.some((effect) => effect.type === "stop-playback"));
});

test("closing the session stops playback and the pipeline", () => {
  const responding = run([
    ...opened,
    { type: "ptt/press" },
    { type: "transcript/final", text: "hello", turnId: "u1" },
    { type: "assistant/stream-start", responseId: 9 },
    { type: "playback/started" },
  ]);
  const closed = run([{ type: "session/close" }], responding.state);
  assert.equal(closed.state.status, "idle");
  assert.deepEqual(closed.effects, [
    { type: "stop-playback", responseId: 9 },
    { type: "set-mic-open", open: false },
    { type: "stop-pipeline" },
  ]);
  assert.deepEqual(
    closed.state.turns,
    responding.state.turns,
    "history survives",
  );
});

test("unknown events leave the state object untouched", () => {
  const { state } = run(opened);
  const next = reduceVoiceConversation(state, { type: "not/a/real/event" });
  assert.equal(next.state, state);
  assert.deepEqual(next.effects, []);
});

test("a failure arriving after the session closed is ignored", () => {
  const closed = run([
    ...opened,
    { type: "ptt/press" },
    { type: "session/close" },
  ]);
  const late = run(
    [
      {
        type: "error",
        error: { code: "mic_unavailable", message: "No microphone" },
      },
    ],
    closed.state,
  );
  assert.equal(
    late.state,
    closed.state,
    "teardown failures cannot reopen the surface",
  );
  assert.deepEqual(late.effects, []);
});
