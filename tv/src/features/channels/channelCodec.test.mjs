import assert from "node:assert/strict";
import test from "node:test";

import { buildChannelList, parseChannelEvent } from "./channelCodec.ts";

function makeChannelEvent(overrides = {}) {
  const {
    id = "c".repeat(64),
    channelId = "11111111-1111-1111-1111-111111111111",
    created_at = 1_700_000_000,
    extraTags = [],
    name = "general",
  } = overrides;
  return {
    id,
    pubkey: "b".repeat(64),
    kind: 39000,
    created_at,
    tags: [
      ["d", channelId],
      ["name", name],
      ["about", "이야기 나누는 곳"],
      ["public"],
      ["closed"],
      ["t", "stream"],
      ...extraTags,
    ],
    content: "",
    sig: "f".repeat(128),
  };
}

test("parseChannelEvent: 39000 태그를 해석한다", () => {
  const channel = parseChannelEvent(makeChannelEvent());
  assert.ok(channel);
  assert.equal(channel.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(channel.name, "general");
  assert.equal(channel.about, "이야기 나누는 곳");
  assert.equal(channel.channelType, "stream");
  assert.equal(channel.hidden, false);
  assert.equal(channel.archived, false);
});

test("parseChannelEvent: 다른 kind·이름 없음은 null", () => {
  const wrongKind = makeChannelEvent();
  wrongKind.kind = 1;
  assert.equal(parseChannelEvent(wrongKind), null);
  const noName = makeChannelEvent();
  noName.tags = noName.tags.filter((tag) => tag[0] !== "name");
  assert.equal(parseChannelEvent(noName), null);
});

test("buildChannelList: 숨김(DM)·보관 채널은 빠진다", () => {
  const visible = makeChannelEvent({ name: "보임" });
  const hidden = makeChannelEvent({
    id: "d".repeat(64),
    channelId: "22222222-2222-2222-2222-222222222222",
    name: "디엠",
    extraTags: [["hidden"]],
  });
  const archived = makeChannelEvent({
    id: "e".repeat(64),
    channelId: "33333333-3333-3333-3333-333333333333",
    name: "보관됨",
    extraTags: [["archived", "true"]],
  });
  const list = buildChannelList([visible, hidden, archived]);
  assert.deepEqual(
    list.map((channel) => channel.name),
    ["보임"],
  );
});

test("buildChannelList: 같은 채널은 최신 판만, 정렬은 이름순", () => {
  const oldName = makeChannelEvent({ created_at: 100, name: "옛이름" });
  const newName = makeChannelEvent({
    id: "a".repeat(64),
    created_at: 200,
    name: "나중이름",
  });
  const other = makeChannelEvent({
    id: "9".repeat(64),
    channelId: "44444444-4444-4444-4444-444444444444",
    name: "가나다",
  });
  const list = buildChannelList([oldName, newName, other]);
  assert.deepEqual(
    list.map((channel) => channel.name),
    ["가나다", "나중이름"],
  );
});
