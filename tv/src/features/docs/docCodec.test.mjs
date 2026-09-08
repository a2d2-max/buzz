import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDocList,
  compareDocPageVersions,
  docPageIdFromDTag,
  parseDocPageEvent,
} from "./docCodec.ts";

const PAGE_ID = "3f0c2b1a-7d4e-4c9a-9b1e-2a6f8d5c4e10";

function makeDocEvent(overrides = {}) {
  const {
    id = "e".repeat(64),
    kind = 30623,
    created_at = 1_700_000_000,
    pageId = PAGE_ID,
    content = {},
    tags,
  } = overrides;
  return {
    id,
    pubkey: "a".repeat(64),
    kind,
    created_at,
    tags: tags ?? [
      ["d", `doc:${pageId}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "제목",
      body: "# 본문",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 2,
      ...content,
    }),
    sig: "f".repeat(128),
  };
}

test("docPageIdFromDTag: doc: 접두어만 받는다", () => {
  assert.equal(docPageIdFromDTag(`doc:${PAGE_ID}`), PAGE_ID);
  assert.equal(docPageIdFromDTag(PAGE_ID), null);
  assert.equal(docPageIdFromDTag("doc:../etc"), null);
  assert.equal(docPageIdFromDTag("doc:"), null);
});

test("parseDocPageEvent: 전용 kind 30623 을 해석한다", () => {
  const page = parseDocPageEvent(makeDocEvent());
  assert.ok(page);
  assert.equal(page.id, PAGE_ID);
  assert.equal(page.title, "제목");
  assert.equal(page.body, "# 본문");
  assert.equal(page.eventKind, 30623);
  assert.equal(page.deleted, false);
});

test("parseDocPageEvent: 레거시 30078 도 읽는다", () => {
  const page = parseDocPageEvent(makeDocEvent({ kind: 30078 }));
  assert.ok(page);
  assert.equal(page.eventKind, 30078);
});

test("parseDocPageEvent: 다른 kind·태그 빠짐·깨진 JSON 은 null", () => {
  assert.equal(parseDocPageEvent(makeDocEvent({ kind: 1 })), null);
  assert.equal(
    parseDocPageEvent(makeDocEvent({ tags: [["d", `doc:${PAGE_ID}`]] })),
    null,
  );
  const broken = makeDocEvent();
  broken.content = "{broken";
  assert.equal(parseDocPageEvent(broken), null);
});

test("compareDocPageVersions: created_at 최신이 이기고 동률은 id 큰 쪽", () => {
  const older = parseDocPageEvent(makeDocEvent({ created_at: 100 }));
  const newer = parseDocPageEvent(makeDocEvent({ created_at: 200 }));
  assert.ok(compareDocPageVersions(newer, older) > 0);
  const idSmall = parseDocPageEvent(makeDocEvent({ id: "1".repeat(64) }));
  const idBig = parseDocPageEvent(makeDocEvent({ id: "2".repeat(64) }));
  assert.ok(compareDocPageVersions(idBig, idSmall) > 0);
});

test("buildDocList: 페이지별 최신 판만 남는다 (레거시→전용 승계 포함)", () => {
  const legacyOld = makeDocEvent({
    kind: 30078,
    id: "1".repeat(64),
    created_at: 100,
    content: { title: "옛 판" },
  });
  const dedicatedNew = makeDocEvent({
    kind: 30623,
    id: "2".repeat(64),
    created_at: 200,
    content: { title: "새 판" },
  });
  const list = buildDocList([legacyOld, dedicatedNew]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "새 판");
  assert.equal(list[0].eventKind, 30623);
});

test("buildDocList: 지운 페이지는 빠지고 자식은 루트로 올라온다", () => {
  const parent = makeDocEvent({
    pageId: "parent-1",
    id: "3".repeat(64),
    content: { title: "부모", deleted: true },
  });
  const child = makeDocEvent({
    pageId: "child-1",
    id: "4".repeat(64),
    content: { title: "자식", parentId: "parent-1" },
  });
  const list = buildDocList([parent, child]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "자식");
  assert.equal(list[0].depth, 0);
});

test("buildDocList: 트리 순서(order→제목)와 들여쓰기 깊이", () => {
  const events = [
    makeDocEvent({
      pageId: "root-b",
      id: "5".repeat(64),
      content: { title: "둘째", order: 2 },
    }),
    makeDocEvent({
      pageId: "root-a",
      id: "6".repeat(64),
      content: { title: "첫째", order: 1 },
    }),
    makeDocEvent({
      pageId: "child-a",
      id: "7".repeat(64),
      content: { title: "첫째의 자식", parentId: "root-a", order: 0 },
    }),
  ];
  const list = buildDocList(events);
  assert.deepEqual(
    list.map((entry) => [entry.title, entry.depth]),
    [
      ["첫째", 0],
      ["첫째의 자식", 1],
      ["둘째", 0],
    ],
  );
});
