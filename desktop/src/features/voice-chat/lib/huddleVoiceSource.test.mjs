import assert from "node:assert/strict";
import test from "node:test";

import { createHuddleVoiceSource } from "./huddleVoiceSource.ts";

const CHANNEL = "huddle-room";
const ME = "me-pubkey";
const AGENT = "agent-pubkey";

function source(overrides = {}) {
  return createHuddleVoiceSource({
    agentPubkeys: new Set([AGENT]),
    channelId: CHANNEL,
    selfPubkey: ME,
    ...overrides,
  });
}

function message({
  id = "e1",
  pubkey = ME,
  content = "hello",
  kind = 40002,
  channel = CHANNEL,
  tags,
} = {}) {
  return {
    content,
    id,
    kind,
    pubkey,
    tags: tags ?? [["h", channel]],
  };
}

test("my own huddle message becomes a final user transcript", () => {
  const events = source().handle(
    message({ content: "ship the release", id: "u1" }),
  );
  assert.deepEqual(events, [
    { text: "ship the release", turnId: "u1", type: "transcript/final" },
  ]);
});

test("an agent message becomes a complete assistant stream", () => {
  const feed = source();
  const events = feed.handle(
    message({ content: "On it.", id: "a1", pubkey: AGENT }),
  );
  assert.deepEqual(events, [
    { responseId: 1, type: "assistant/stream-start" },
    { text: "On it.", type: "assistant/stream-delta" },
    { type: "assistant/stream-end" },
  ]);
});

test("response ids increase so a later reply cannot reuse a cancelled one", () => {
  const feed = source();
  feed.handle(message({ id: "a1", pubkey: AGENT }));
  const second = feed.handle(message({ id: "a2", pubkey: AGENT }));
  assert.equal(second.at(0)?.responseId, 2);
});

test("the speaking agent stays resolvable so barge-in can interrupt it", () => {
  const feed = source();
  feed.handle(message({ id: "a1", pubkey: AGENT }));
  assert.equal(feed.speakerFor(1), AGENT);
  assert.equal(feed.speakerFor(99), null);
});

test("a repeated event is ignored", () => {
  const feed = source();
  assert.equal(feed.handle(message({ id: "u1" })).length, 1);
  assert.deepEqual(feed.handle(message({ id: "u1" })), []);
});

test("messages from another channel or kind are ignored", () => {
  const feed = source();
  assert.deepEqual(feed.handle(message({ channel: "elsewhere", id: "x" })), []);
  assert.deepEqual(feed.handle(message({ id: "y", kind: 40003 })), []);
});

test("a third participant is not treated as the assistant or as me", () => {
  const feed = source();
  assert.deepEqual(
    feed.handle(message({ id: "z", pubkey: "someone-else" })),
    [],
  );
});

test("system and empty agent output never opens a response", () => {
  const feed = source();
  assert.deepEqual(
    feed.handle(
      message({ content: "[System] joined", id: "s1", pubkey: AGENT }),
    ),
    [],
  );
  assert.deepEqual(
    feed.handle(message({ content: "   ", id: "s2", pubkey: AGENT })),
    [],
  );
});

test("an empty utterance of mine is dropped before it reaches the machine", () => {
  assert.deepEqual(source().handle(message({ content: "  ", id: "u9" })), []);
});

test("without a known identity nothing is attributed to me", () => {
  const feed = source({ selfPubkey: null });
  assert.deepEqual(feed.handle(message({ id: "u1", pubkey: ME })), []);
});

test("the agent set can be refreshed mid-huddle", () => {
  const feed = source({ agentPubkeys: new Set() });
  assert.deepEqual(feed.handle(message({ id: "a1", pubkey: AGENT })), []);
  feed.setAgentPubkeys(new Set([AGENT]));
  assert.equal(
    feed.handle(message({ id: "a2", pubkey: AGENT })).at(0)?.type,
    "assistant/stream-start",
  );
});

test("only recent speakers stay resolvable so a long huddle stays bounded", () => {
  const feed = source();
  for (let index = 1; index <= 200; index += 1) {
    feed.handle(message({ id: `a${index}`, pubkey: AGENT }));
  }
  assert.equal(
    feed.speakerFor(200),
    AGENT,
    "the newest reply is interruptible",
  );
  assert.equal(feed.speakerFor(1), null, "the oldest was released");
});
