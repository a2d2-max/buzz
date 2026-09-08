import assert from "node:assert/strict";
import test from "node:test";

import {
  insertMessage,
  parseProfileEvent,
  parseTimelineMessage,
  shortPubkey,
} from "./messageCodec.ts";

function makeMessageEvent(overrides = {}) {
  const {
    id = "1".repeat(64),
    kind = 9,
    created_at = 1_700_000_000,
    content = "안녕하세요 **여러분**",
    tags = [["h", "11111111-1111-1111-1111-111111111111"]],
  } = overrides;
  return {
    id,
    pubkey: "a".repeat(64),
    kind,
    created_at,
    tags,
    content,
    sig: "f".repeat(128),
  };
}

test("parseTimelineMessage: kind 9 와 40002 를 읽는다", () => {
  assert.ok(parseTimelineMessage(makeMessageEvent({ kind: 9 })));
  assert.ok(parseTimelineMessage(makeMessageEvent({ kind: 40002 })));
});

test("parseTimelineMessage: 다른 kind·빈 내용은 null", () => {
  assert.equal(parseTimelineMessage(makeMessageEvent({ kind: 7 })), null);
  assert.equal(parseTimelineMessage(makeMessageEvent({ content: "" })), null);
});

test("parseTimelineMessage: e 태그가 있으면 답글 표시", () => {
  const root = "2".repeat(64);
  const message = parseTimelineMessage(
    makeMessageEvent({ tags: [["e", root]] }),
  );
  assert.equal(message.replyTo, root);
});

test("insertMessage: 중복은 버리고 시간순을 지킨다", () => {
  const first = parseTimelineMessage(
    makeMessageEvent({ id: "1".repeat(64), created_at: 100 }),
  );
  const second = parseTimelineMessage(
    makeMessageEvent({ id: "2".repeat(64), created_at: 200 }),
  );
  let list = insertMessage([], second);
  list = insertMessage(list, first);
  assert.deepEqual(
    list.map((message) => message.createdAt),
    [100, 200],
  );
  const again = insertMessage(list, first);
  assert.equal(again, list);
});

test("parseProfileEvent: display_name → displayName → name 순서", () => {
  const base = {
    id: "3".repeat(64),
    pubkey: "c".repeat(64),
    kind: 0,
    created_at: 1,
    tags: [],
    sig: "f".repeat(128),
  };
  assert.equal(
    parseProfileEvent({
      ...base,
      content: JSON.stringify({ name: "이름", display_name: "표시이름" }),
    }).displayName,
    "표시이름",
  );
  assert.equal(
    parseProfileEvent({ ...base, content: JSON.stringify({ name: "이름" }) })
      .displayName,
    "이름",
  );
  assert.equal(parseProfileEvent({ ...base, content: "{broken" }), null);
  assert.equal(
    parseProfileEvent({ ...base, content: JSON.stringify({}) }),
    null,
  );
});

test("shortPubkey: 앞 8자리", () => {
  assert.equal(shortPubkey("abcdef0123456789"), "abcdef01");
});
