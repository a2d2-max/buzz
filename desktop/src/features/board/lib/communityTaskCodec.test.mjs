import assert from "node:assert/strict";
import test from "node:test";

import {
  communityTaskDTag,
  communityTaskIdFromDTag,
  communityTaskTags,
  nextMonotonicSeconds,
  normalizeCommunityTaskAssignees,
  parseCommunityTaskContent,
  parseCommunityTaskEvent,
  serializeCommunityTaskContent,
  tombstoneCommunityTaskContent,
} from "./communityTaskCodec.ts";

const AUTHOR = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);

function content(overrides = {}) {
  return {
    author: AUTHOR,
    title: "Write the release notes",
    body: "- what shipped\n- what broke",
    status: "todo",
    assignees: [ASSIGNEE],
    order: 1_700_000_000_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_700_000_100,
    kind: 30078,
    tags: [
      ["d", "community-task:card-1"],
      ["t", "community-task"],
    ],
    content: serializeCommunityTaskContent(content()),
    sig: "s".repeat(128),
    ...overrides,
  };
}

test("a card round-trips through serialize and parse", () => {
  const original = content({ due: 1_700_500_000 });
  const parsed = parseCommunityTaskContent(
    JSON.parse(serializeCommunityTaskContent(original)),
  );
  assert.deepEqual(parsed, original);
});

test("serialize writes the brief's key order with author last and omits absent optionals", () => {
  const wire = JSON.parse(serializeCommunityTaskContent(content()));
  assert.deepEqual(Object.keys(wire), [
    "title",
    "body",
    "status",
    "assignees",
    "order",
    "createdAt",
    "updatedAt",
    "author",
  ]);
  assert.equal("due" in wire, false);
  assert.equal("deleted" in wire, false);

  const withOptionals = JSON.parse(
    serializeCommunityTaskContent(content({ due: 5, deleted: true })),
  );
  assert.deepEqual(Object.keys(withOptionals), [
    "title",
    "body",
    "status",
    "assignees",
    "due",
    "order",
    "createdAt",
    "updatedAt",
    "deleted",
    "author",
  ]);
});

test("parse rejects a body missing any required field", () => {
  for (const field of [
    "author",
    "title",
    "status",
    "order",
    "createdAt",
    "updatedAt",
  ]) {
    const broken = content();
    delete broken[field];
    assert.equal(parseCommunityTaskContent(broken), null, `missing ${field}`);
  }
  assert.equal(parseCommunityTaskContent(content({ status: "blocked" })), null);
  assert.equal(parseCommunityTaskContent(content({ author: "nope" })), null);
  assert.equal(parseCommunityTaskContent(content({ order: "1" })), null);
  assert.equal(parseCommunityTaskContent(content({ createdAt: -1 })), null);
  assert.equal(parseCommunityTaskContent(null), null);
  assert.equal(parseCommunityTaskContent([]), null);
  assert.equal(parseCommunityTaskContent("{}"), null);
});

test("parse drops malformed optionals instead of hiding the card", () => {
  const parsed = parseCommunityTaskContent(
    content({
      assignees: [ASSIGNEE.toUpperCase(), " zz ", 42, ASSIGNEE],
      body: undefined,
      deleted: "yes",
      due: "tomorrow",
    }),
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.assignees, [ASSIGNEE]);
  assert.equal(parsed.body, "");
  assert.equal(parsed.due, undefined);
  assert.equal(parsed.deleted, undefined);
});

test("parse normalizes the author and honors an explicit tombstone", () => {
  const parsed = parseCommunityTaskContent(
    content({ author: AUTHOR.toUpperCase(), deleted: true }),
  );
  assert.equal(parsed?.author, AUTHOR);
  assert.equal(parsed?.deleted, true);
});

test("assignee normalization lowercases, de-duplicates, and drops non-pubkeys", () => {
  assert.deepEqual(
    normalizeCommunityTaskAssignees([
      ASSIGNEE.toUpperCase(),
      ASSIGNEE,
      AUTHOR,
      "short",
      null,
    ]),
    [ASSIGNEE, AUTHOR],
  );
  assert.deepEqual(normalizeCommunityTaskAssignees("nope"), []);
});

test("d-tag helpers agree with each other and reject foreign tags", () => {
  assert.equal(communityTaskDTag("card-1"), "community-task:card-1");
  assert.equal(communityTaskIdFromDTag("community-task:card-1"), "card-1");
  assert.equal(communityTaskIdFromDTag("read-state:card-1"), null);
  assert.equal(communityTaskIdFromDTag("community-task:"), null);
  assert.equal(communityTaskIdFromDTag("community-task:has space"), null);
  assert.deepEqual(communityTaskTags("card-1"), [
    ["d", "community-task:card-1"],
    ["t", "community-task"],
  ]);
});

test("a relay event decodes into a revision keyed by its d-tag", () => {
  const revision = parseCommunityTaskEvent(event());
  assert.deepEqual(revision, {
    id: "card-1",
    content: content(),
    signer: AUTHOR,
    eventId: "e".repeat(64),
    eventCreatedAt: 1_700_000_100,
  });
});

test("events that are not cards are ignored", () => {
  assert.equal(parseCommunityTaskEvent(event({ kind: 30079 })), null);
  assert.equal(parseCommunityTaskEvent(event({ content: "{" })), null);
  assert.equal(
    parseCommunityTaskEvent(event({ tags: [["t", "community-task"]] })),
    null,
    "no d-tag",
  );
  assert.equal(
    parseCommunityTaskEvent(
      event({
        tags: [
          ["d", "community-task:card-1"],
          ["d", "community-task:card-2"],
        ],
      }),
    ),
    null,
    "two d-tags",
  );
  assert.equal(
    parseCommunityTaskEvent(event({ tags: [["d", "channel-sections"]] })),
    null,
    "other app data",
  );
});

test("a tombstone keeps identity and timestamps but blanks the text", () => {
  const original = content({ due: 7, updatedAt: 1_700_000_100 });
  const tombstone = tombstoneCommunityTaskContent(original, 1_600_000_000);
  assert.deepEqual(tombstone, {
    author: AUTHOR,
    title: "",
    body: "",
    status: "todo",
    assignees: [],
    order: original.order,
    createdAt: original.createdAt,
    // A lagging clock still lands after the revision it retires.
    updatedAt: 1_700_000_101,
    deleted: true,
  });
  const parsed = parseCommunityTaskContent(
    JSON.parse(serializeCommunityTaskContent(tombstone)),
  );
  assert.deepEqual(parsed, tombstone);
});

test("nextMonotonicSeconds never goes backwards", () => {
  assert.equal(nextMonotonicSeconds(100, undefined), 100);
  assert.equal(nextMonotonicSeconds(100.9, undefined), 100);
  assert.equal(nextMonotonicSeconds(100, 50), 100);
  assert.equal(nextMonotonicSeconds(100, 100), 101);
  assert.equal(nextMonotonicSeconds(100, 200), 201);
});
