import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDocPageEventInput,
  COMMUNITY_DOC_TAG,
  createDocPageId,
  DOC_MAX_CONTENT_BYTES,
  docPageContentEquals,
  docPageDTag,
  docPageIdFromDTag,
  measureDocPageContentBytes,
  parseDocPageEvent,
} from "./docPageCodec.ts";

const PAGE_ID = "3f0c2b1a-7d4e-4c9a-9b1e-2a6f8d5c4e10";

function makeEvent(overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 30078,
    tags: [
      ["d", `doc:${PAGE_ID}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "Onboarding",
      body: "# Welcome\n\nHello.",
      parentId: null,
      order: 2,
      icon: "📘",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
    }),
    sig: "f".repeat(128),
    ...overrides,
  };
}

// ── d-tag helpers ────────────────────────────────────────────────────────────

test("docPageDTag / docPageIdFromDTag: round trip", () => {
  assert.equal(docPageDTag(PAGE_ID), `doc:${PAGE_ID}`);
  assert.equal(docPageIdFromDTag(`doc:${PAGE_ID}`), PAGE_ID);
});

test("docPageIdFromDTag: rejects other prefixes, empty ids, and path-like ids", () => {
  assert.equal(docPageIdFromDTag("read-state:abc"), null);
  assert.equal(docPageIdFromDTag("doc:"), null);
  assert.equal(docPageIdFromDTag("doc: with space"), null);
  assert.equal(docPageIdFromDTag(PAGE_ID), null);
  // A page id rides in the `/docs/$pageId` route, so dots and slashes are out.
  assert.equal(docPageIdFromDTag("doc:.."), null);
  assert.equal(docPageIdFromDTag("doc:."), null);
  assert.equal(docPageIdFromDTag("doc:a/b"), null);
  assert.equal(docPageIdFromDTag("doc:-leading-dash"), null);
  assert.equal(docPageIdFromDTag("doc:Ok_id-1"), "Ok_id-1");
});

test("createDocPageId: returns a uuid", () => {
  const id = createDocPageId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.notEqual(id, createDocPageId());
});

// ── parseDocPageEvent ────────────────────────────────────────────────────────

test("parseDocPageEvent: valid event yields a page with event provenance", () => {
  const page = parseDocPageEvent(makeEvent());
  assert.deepEqual(page, {
    id: PAGE_ID,
    author: "a".repeat(64),
    eventId: "e".repeat(64),
    eventCreatedAt: 1_700_000_000,
    title: "Onboarding",
    body: "# Welcome\n\nHello.",
    parentId: null,
    order: 2,
    icon: "📘",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    deleted: false,
  });
});

test("parseDocPageEvent: wrong kind, missing t tag, or foreign d-tag → null", () => {
  assert.equal(parseDocPageEvent(makeEvent({ kind: 30023 })), null);
  assert.equal(
    parseDocPageEvent(makeEvent({ tags: [["d", `doc:${PAGE_ID}`]] })),
    null,
  );
  assert.equal(
    parseDocPageEvent(
      makeEvent({
        tags: [
          ["d", "channel-sections"],
          ["t", COMMUNITY_DOC_TAG],
        ],
      }),
    ),
    null,
  );
  assert.equal(
    parseDocPageEvent(makeEvent({ tags: [["t", COMMUNITY_DOC_TAG]] })),
    null,
  );
});

test("parseDocPageEvent: malformed content → null", () => {
  assert.equal(parseDocPageEvent(makeEvent({ content: "{not json" })), null);
  assert.equal(parseDocPageEvent(makeEvent({ content: "[]" })), null);
  assert.equal(parseDocPageEvent(makeEvent({ content: "null" })), null);
  assert.equal(
    parseDocPageEvent(
      makeEvent({ content: JSON.stringify({ body: "x", parentId: null }) }),
    ),
    null,
    "title is required",
  );
  assert.equal(
    parseDocPageEvent(
      makeEvent({
        content: JSON.stringify({ title: "t", body: 5, parentId: null }),
      }),
    ),
    null,
    "body must be a string",
  );
  assert.equal(
    parseDocPageEvent(
      makeEvent({
        content: JSON.stringify({ title: "t", body: "", parentId: 7 }),
      }),
    ),
    null,
    "parentId must be a string or null",
  );
  assert.equal(
    parseDocPageEvent(
      makeEvent({
        content: JSON.stringify({
          title: "t",
          body: "",
          parentId: null,
          order: "first",
        }),
      }),
    ),
    null,
    "order must be a finite number",
  );
});

test("parseDocPageEvent: lenient defaults for optional fields", () => {
  const page = parseDocPageEvent(
    makeEvent({
      content: JSON.stringify({ title: "Bare", body: "", parentId: null }),
    }),
  );
  assert.ok(page);
  assert.equal(page.order, 0);
  assert.equal(page.icon, undefined);
  assert.equal(page.createdAt, 1_700_000_000_000);
  assert.equal(page.updatedAt, 1_700_000_000_000);
  assert.equal(page.deleted, false);
});

test("parseDocPageEvent: deleted is only honoured as literal true", () => {
  const tombstone = parseDocPageEvent(
    makeEvent({
      content: JSON.stringify({
        title: "Gone",
        body: "",
        parentId: null,
        deleted: true,
      }),
    }),
  );
  assert.equal(tombstone?.deleted, true);
  const notDeleted = parseDocPageEvent(
    makeEvent({
      content: JSON.stringify({
        title: "Still here",
        body: "",
        parentId: null,
        deleted: "yes",
      }),
    }),
  );
  assert.equal(notDeleted?.deleted, false);
});

test("parseDocPageEvent: a page cannot be its own parent", () => {
  const page = parseDocPageEvent(
    makeEvent({
      content: JSON.stringify({ title: "Loop", body: "", parentId: PAGE_ID }),
    }),
  );
  assert.equal(page?.parentId, null);
});

test("parseDocPageEvent: non-string icon is dropped, not fatal", () => {
  const page = parseDocPageEvent(
    makeEvent({
      content: JSON.stringify({
        title: "t",
        body: "",
        parentId: null,
        icon: 42,
      }),
    }),
  );
  assert.equal(page?.icon, undefined);
});

// ── buildDocPageEventInput ───────────────────────────────────────────────────

test("buildDocPageEventInput: kind 30078 with doc d-tag and community-doc t-tag", () => {
  const input = buildDocPageEventInput({
    id: PAGE_ID,
    title: "Roadmap",
    body: "- item",
    parentId: "parent-id",
    order: 3,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(input.kind, 30078);
  assert.deepEqual(input.tags, [
    ["d", `doc:${PAGE_ID}`],
    ["t", "community-doc"],
  ]);
  assert.deepEqual(JSON.parse(input.content), {
    title: "Roadmap",
    body: "- item",
    parentId: "parent-id",
    order: 3,
    createdAt: 1,
    updatedAt: 2,
  });
});

test("buildDocPageEventInput: icon and deleted appear only when set", () => {
  const withExtras = JSON.parse(
    buildDocPageEventInput({
      id: PAGE_ID,
      title: "t",
      body: "",
      parentId: null,
      order: 0,
      icon: "🧭",
      createdAt: 1,
      updatedAt: 2,
      deleted: true,
    }).content,
  );
  assert.equal(withExtras.icon, "🧭");
  assert.equal(withExtras.deleted, true);

  const bare = JSON.parse(
    buildDocPageEventInput({
      id: PAGE_ID,
      title: "t",
      body: "",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 2,
      deleted: false,
    }).content,
  );
  assert.equal("icon" in bare, false);
  assert.equal("deleted" in bare, false);
});

test("buildDocPageEventInput → parseDocPageEvent round trip", () => {
  const input = buildDocPageEventInput({
    id: PAGE_ID,
    title: "Round",
    body: "![logo](https://example.com/logo.png)",
    parentId: "p",
    order: 9,
    icon: "🔁",
    createdAt: 10,
    updatedAt: 20,
  });
  const page = parseDocPageEvent({
    ...makeEvent(),
    ...input,
  });
  assert.ok(page);
  assert.equal(page.id, PAGE_ID);
  assert.equal(page.title, "Round");
  assert.equal(page.body, "![logo](https://example.com/logo.png)");
  assert.equal(page.parentId, "p");
  assert.equal(page.order, 9);
  assert.equal(page.icon, "🔁");
  assert.equal(page.createdAt, 10);
  assert.equal(page.updatedAt, 20);
  assert.equal(page.deleted, false);
});

// ── docPageContentEquals / measureDocPageContentBytes ───────────────────────

const BASE_CONTENT = {
  title: "T",
  body: "b",
  parentId: null,
  order: 1,
  createdAt: 1,
  updatedAt: 2,
};

test("docPageContentEquals: same visible fields, timestamps ignored", () => {
  assert.equal(
    docPageContentEquals(BASE_CONTENT, {
      ...BASE_CONTENT,
      createdAt: 99,
      updatedAt: 100,
    }),
    true,
  );
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, deleted: false }),
    true,
    "absent and false tombstone flags are the same thing",
  );
});

test("docPageContentEquals: any visible field difference counts", () => {
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, body: "c" }),
    false,
  );
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, order: 2 }),
    false,
  );
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, parentId: "p" }),
    false,
  );
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, icon: "x" }),
    false,
  );
  assert.equal(
    docPageContentEquals(BASE_CONTENT, { ...BASE_CONTENT, deleted: true }),
    false,
  );
});

test("measureDocPageContentBytes: counts UTF-8 bytes of the serialized content", () => {
  const ascii = measureDocPageContentBytes({
    ...BASE_CONTENT,
    id: PAGE_ID,
    body: "abcd",
  });
  const hangul = measureDocPageContentBytes({
    ...BASE_CONTENT,
    id: PAGE_ID,
    body: "가나다라",
  });
  assert.equal(hangul - ascii, 4 * 3 - 4, "each Hangul syllable is 3 bytes");
  assert.equal(
    DOC_MAX_CONTENT_BYTES,
    256 * 1024,
    "mirrors the relay's MAX_EVENT_CONTENT_BYTES",
  );
});
