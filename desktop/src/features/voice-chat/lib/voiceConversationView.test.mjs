import assert from "node:assert/strict";
import test from "node:test";

import {
  createVoiceConversationState,
  reduceVoiceConversation,
} from "./voiceConversationMachine.ts";
import { describeVoiceConversation } from "./voiceConversationView.ts";

function stateAfter(events) {
  let state = createVoiceConversationState();
  for (const event of events) {
    state = reduceVoiceConversation(state, event).state;
  }
  return state;
}

const opened = [{ type: "session/open" }, { type: "session/ready" }];

test("every status has a spoken-language label and a matching tone", () => {
  const seen = new Map();
  const cases = [
    [[], "idle"],
    [[{ type: "session/open" }], "connecting"],
    [opened, "listening"],
    [[...opened, { type: "ptt/press" }], "capturing"],
    [
      [
        ...opened,
        { type: "ptt/press" },
        { text: "hi", turnId: "u1", type: "transcript/final" },
      ],
      "thinking",
    ],
    [
      [
        ...opened,
        { type: "ptt/press" },
        { text: "hi", turnId: "u1", type: "transcript/final" },
        { responseId: 1, type: "assistant/stream-start" },
      ],
      "responding",
    ],
    [
      [
        ...opened,
        { error: { code: "tts_failed", message: "nope" }, type: "error" },
      ],
      "error",
    ],
  ];
  for (const [events, status] of cases) {
    const view = describeVoiceConversation(stateAfter(events));
    assert.equal(view.status, status);
    assert.ok(view.label.length > 0, `${status} needs a label`);
    assert.ok(view.hint.length > 0, `${status} needs a hint`);
    assert.equal(seen.has(view.label), false, `${view.label} is reused`);
    seen.set(view.label, status);
  }
});

test("only the error state offers a retry", () => {
  assert.equal(describeVoiceConversation(stateAfter(opened)).canRetry, false);
  const failed = stateAfter([
    ...opened,
    {
      error: { code: "mic_unavailable", message: "No microphone" },
      type: "error",
    },
  ]);
  const view = describeVoiceConversation(failed);
  assert.equal(view.canRetry, true);
  assert.equal(view.tone, "danger");
  assert.equal(view.hint, "No microphone");
});

test("the live region only announces settled states", () => {
  const capturing = describeVoiceConversation(
    stateAfter([...opened, { type: "ptt/press" }]),
  );
  assert.equal(capturing.announcement, capturing.label);
  assert.equal(capturing.announcementPoliteness, "polite");

  const failed = describeVoiceConversation(
    stateAfter([
      ...opened,
      {
        error: { code: "tts_failed", message: "Playback failed" },
        type: "error",
      },
    ]),
  );
  assert.equal(failed.announcementPoliteness, "assertive");
  assert.ok(failed.announcement.includes("Playback failed"));
});

test("the microphone button reports its accessible pressed state", () => {
  const listening = describeVoiceConversation(stateAfter(opened));
  assert.equal(listening.micButton.pressed, false);
  assert.equal(listening.micButton.disabled, false);
  assert.ok(/hold/i.test(listening.micButton.label));

  const held = describeVoiceConversation(
    stateAfter([...opened, { type: "ptt/press" }]),
  );
  assert.equal(held.micButton.pressed, true);

  const idle = describeVoiceConversation(createVoiceConversationState());
  assert.equal(idle.micButton.disabled, true);
});

test("hands-free relabels the microphone button as a mute toggle", () => {
  const handsFree = describeVoiceConversation(
    stateAfter([{ mode: "hands_free", type: "input-mode/set" }, ...opened]),
  );
  assert.equal(
    handsFree.micButton.pressed,
    true,
    "an open mic reads as pressed",
  );
  assert.ok(/mute/i.test(handsFree.micButton.label));

  const muted = describeVoiceConversation(
    stateAfter([
      { mode: "hands_free", type: "input-mode/set" },
      ...opened,
      { muted: true, type: "mic/set-muted" },
    ]),
  );
  assert.equal(muted.micButton.pressed, false);
  assert.ok(/unmute/i.test(muted.micButton.label));
});

test("the transcript merges settled turns with the live partial", () => {
  const state = stateAfter([
    ...opened,
    { type: "ptt/press" },
    { text: "ship it", turnId: "u1", type: "transcript/final" },
    { responseId: 1, type: "assistant/stream-start" },
    { text: "On it", type: "assistant/stream-delta" },
    { type: "playback/started" },
  ]);
  const view = describeVoiceConversation(state);
  assert.deepEqual(
    view.transcript.map((entry) => [entry.role, entry.text, entry.pending]),
    [
      ["user", "ship it", false],
      ["assistant", "On it", true],
    ],
  );
  assert.equal(view.transcript.at(-1)?.interrupted, false);
});

test("a live partial shows as a pending user entry", () => {
  const view = describeVoiceConversation(
    stateAfter([
      ...opened,
      { type: "ptt/press" },
      { text: "what is", type: "transcript/partial" },
    ]),
  );
  assert.deepEqual(
    view.transcript.map((entry) => [entry.role, entry.pending]),
    [["user", true]],
  );
});

test("transcript entries keep stable keys across renders", () => {
  const first = describeVoiceConversation(
    stateAfter([
      ...opened,
      { type: "ptt/press" },
      { text: "ship", type: "transcript/partial" },
    ]),
  );
  const second = describeVoiceConversation(
    stateAfter([
      ...opened,
      { type: "ptt/press" },
      { text: "ship", type: "transcript/partial" },
      { text: "ship it", type: "transcript/partial" },
    ]),
  );
  assert.equal(first.transcript.at(-1)?.key, second.transcript.at(-1)?.key);
});

test("an interrupted assistant turn is marked for the reader", () => {
  const view = describeVoiceConversation(
    stateAfter([
      ...opened,
      { type: "ptt/press" },
      { text: "hi", turnId: "u1", type: "transcript/final" },
      { responseId: 3, type: "assistant/stream-start" },
      { text: "Let me", type: "assistant/stream-delta" },
      { type: "playback/started" },
      { type: "ptt/press" },
    ]),
  );
  const assistant = view.transcript.find((entry) => entry.role === "assistant");
  assert.equal(assistant?.interrupted, true);
  assert.equal(assistant?.pending, false);
});
