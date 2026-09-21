import assert from "node:assert/strict";
import test from "node:test";

import { serializeCommunityTaskContent } from "./communityTaskCodec.ts";
import {
  communityTaskContentOf,
  canDeleteCommunityTask,
  canEditCommunityTask,
  honoredCommunityTaskSigners,
  latestOwnCommunityTaskEventCreatedAt,
  mergeCommunityTaskEvents,
  resolveCommunityTaskLineage,
  upsertCommunityTaskEvent,
} from "./communityTaskMerge.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const MALLORY = "d".repeat(64);

let eventCounter = 0;

/** A signed revision of `card-1` claiming `author`, with sensible defaults. */
function revision({
  author = ALICE,
  signer = author,
  id = "card-1",
  updatedAt = 100,
  eventCreatedAt = updatedAt,
  eventId = `${String(++eventCounter).padStart(4, "0")}${"e".repeat(60)}`,
  ...content
} = {}) {
  return {
    id,
    signer,
    eventId,
    eventCreatedAt,
    content: {
      author,
      title: `rev ${updatedAt} by ${signer.slice(0, 1)}`,
      body: "",
      status: "todo",
      assignees: [],
      order: 1,
      createdAt: 10,
      updatedAt,
      ...content,
    },
  };
}

function event(rev) {
  return {
    id: rev.eventId,
    pubkey: rev.signer,
    created_at: rev.eventCreatedAt,
    kind: 30078,
    tags: [
      ["d", `community-task:${rev.id}`],
      ["t", "community-task"],
    ],
    content: serializeCommunityTaskContent(rev.content),
    sig: "s".repeat(128),
  };
}

test("a lone author revision is the card", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 100, title: "Only one" }),
  ]);
  assert.equal(task?.title, "Only one");
  assert.equal(task?.author, ALICE);
  assert.equal(task?.signer, ALICE);
  assert.equal(task?.id, "card-1");
});

test("an assignee's newer revision wins over the author's", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 100, assignees: [BOB], title: "By Alice" }),
    revision({
      signer: BOB,
      updatedAt: 200,
      assignees: [BOB],
      status: "doing",
      title: "By Bob",
    }),
  ]);
  assert.equal(task?.title, "By Bob");
  assert.equal(task?.status, "doing");
  assert.equal(task?.signer, BOB);
  // The author is the lineage, not whoever signed the winning revision.
  assert.equal(task?.author, ALICE);
});

test("a stranger's revision is ignored even when it is the newest", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 100, title: "By Alice" }),
    revision({ signer: MALLORY, updatedAt: 999, title: "By Mallory" }),
  ]);
  assert.equal(task?.title, "By Alice");
});

test("a removed assignee can no longer edit, even with a newer stamp", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    // Alice assigned Bob, then took him off again.
    revision({ updatedAt: 300, assignees: [], title: "Bob removed" }),
    revision({
      signer: BOB,
      updatedAt: 400,
      assignees: [BOB],
      title: "Bob again",
    }),
  ]);
  assert.equal(task?.title, "Bob removed");
});

test("only the author may grant task editing authority", () => {
  // Bob cannot grant Carol edit authority without an author revision.
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 100, assignees: [BOB] }),
    revision({ signer: BOB, updatedAt: 200, assignees: [BOB, CAROL] }),
    revision({
      signer: CAROL,
      updatedAt: 300,
      assignees: [BOB, CAROL],
      title: "Carol's edit",
    }),
  ]);
  assert.equal(task?.title, "rev 100 by a");
  assert.deepEqual(
    [
      ...honoredCommunityTaskSigners(ALICE, [
        revision({ updatedAt: 100, assignees: [BOB] }),
        revision({ signer: BOB, updatedAt: 200, assignees: [BOB, CAROL] }),
      ]),
    ].sort(),
    [ALICE, BOB].sort(),
  );
});

test("the honored set does not depend on event order", () => {
  const revisions = [
    revision({ updatedAt: 100, assignees: [BOB] }),
    revision({ signer: BOB, updatedAt: 200, assignees: [CAROL] }),
    revision({ signer: CAROL, updatedAt: 300, title: "Carol" }),
  ];
  const forward = resolveCommunityTaskLineage(ALICE, "card-1", revisions);
  const backward = resolveCommunityTaskLineage(
    ALICE,
    "card-1",
    [...revisions].reverse(),
  );
  assert.deepEqual(forward, backward);
  assert.equal(forward?.title, "rev 100 by a");
});

test("the author's tombstone retires the card despite newer assignee edits", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 500, deleted: true, assignees: [] }),
    revision({ signer: BOB, updatedAt: 900, assignees: [BOB] }),
  ]);
  assert.equal(task, null);
});

test("an assignee's tombstone is ignored", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    revision({ updatedAt: 100, assignees: [BOB], title: "Still here" }),
    revision({ signer: BOB, updatedAt: 200, assignees: [BOB], deleted: true }),
  ]);
  assert.equal(task?.title, "Still here");
});

test("a lineage whose author never signed anything is not trusted", () => {
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [
    // Bob claims Alice made this card, but Alice has no event.
    revision({ author: ALICE, signer: BOB, updatedAt: 100, assignees: [BOB] }),
  ]);
  assert.equal(task, null);
  assert.deepEqual(
    mergeCommunityTaskEvents([
      event(revision({ author: ALICE, signer: BOB, updatedAt: 100 })),
    ]),
    [],
  );
});

test("a second creator on the same uuid gets their own card and no say over the first", () => {
  const alices = revision({
    author: ALICE,
    createdAt: 10,
    updatedAt: 100,
    title: "Original",
  });
  // Mallory forges an earlier creation stamp, a newer update stamp, and a
  // tombstone — everything that could plausibly win an ordering contest.
  const mallorys = revision({
    author: MALLORY,
    createdAt: 0,
    updatedAt: 999,
    title: "Squatter",
  });
  const mallorysTombstone = revision({
    author: MALLORY,
    createdAt: 0,
    updatedAt: 1_000,
    deleted: true,
  });

  const tasks = mergeCommunityTaskEvents([event(mallorys), event(alices)]);
  assert.deepEqual(
    tasks.map((task) => [task.author, task.title, task.key]).sort(),
    [
      [ALICE, "Original", `${ALICE}:card-1`],
      [MALLORY, "Squatter", `${MALLORY}:card-1`],
    ].sort(),
    "both lineages render, keyed apart",
  );

  const afterTombstone = mergeCommunityTaskEvents([
    event(mallorysTombstone),
    event(alices),
  ]);
  assert.deepEqual(
    afterTombstone.map((task) => [task.author, task.title]),
    [[ALICE, "Original"]],
    "the squatter's tombstone retires only the squatter's card",
  );
  assert.equal(
    resolveCommunityTaskLineage(ALICE, "card-1", [
      mallorys,
      mallorysTombstone,
      alices,
    ])?.title,
    "Original",
  );
});

test("ties on updatedAt fall back to event created_at, then event id", () => {
  const later = revision({
    updatedAt: 100,
    eventCreatedAt: 101,
    title: "later event",
  });
  const earlier = revision({
    updatedAt: 100,
    eventCreatedAt: 100,
    title: "earlier event",
  });
  assert.equal(
    resolveCommunityTaskLineage(ALICE, "card-1", [earlier, later])?.title,
    "later event",
  );
  const low = revision({
    updatedAt: 100,
    eventId: `0000${"a".repeat(60)}`,
    title: "low id",
  });
  const high = revision({
    updatedAt: 100,
    eventId: `0000${"f".repeat(60)}`,
    title: "high id",
  });
  assert.equal(
    resolveCommunityTaskLineage(ALICE, "card-1", [high, low])?.title,
    "low id",
  );
});

test("mergeCommunityTaskEvents groups by creator and card id and drops junk", () => {
  const tasks = mergeCommunityTaskEvents([
    event(revision({ id: "card-1", title: "One" })),
    event(revision({ id: "card-2", title: "Two", author: BOB })),
    event(revision({ id: "card-3", deleted: true })),
    { ...event(revision({ id: "card-4" })), content: "not json" },
    { ...event(revision({ id: "card-5" })), kind: 1 },
  ]);
  assert.deepEqual(tasks.map((task) => [task.id, task.title]).sort(), [
    ["card-1", "One"],
    ["card-2", "Two"],
  ]);
});

test("edit is author or assignee; delete is author only", () => {
  const task = { author: ALICE, assignees: [BOB] };
  assert.equal(canEditCommunityTask(task, ALICE), true);
  assert.equal(canEditCommunityTask(task, BOB.toUpperCase()), true);
  assert.equal(canEditCommunityTask(task, CAROL), false);
  assert.equal(canEditCommunityTask(task, null), false);
  assert.equal(canDeleteCommunityTask(task, ALICE), true);
  assert.equal(canDeleteCommunityTask(task, BOB), false);
  assert.equal(canDeleteCommunityTask(task, undefined), false);
});

test("upsert replaces only a newer event for the same signer and card", () => {
  const first = event(revision({ updatedAt: 100, eventCreatedAt: 100 }));
  const newer = event(revision({ updatedAt: 200, eventCreatedAt: 200 }));
  const bobs = event(
    revision({ signer: BOB, updatedAt: 150, eventCreatedAt: 150 }),
  );
  const cache = [first];

  const withBob = upsertCommunityTaskEvent(cache, bobs);
  assert.equal(withBob.length, 2, "another signer is appended");

  const replaced = upsertCommunityTaskEvent(withBob, newer);
  assert.deepEqual(
    replaced.map((entry) => entry.id),
    [newer.id, bobs.id],
    "the author's slot is replaced in place",
  );

  assert.equal(
    upsertCommunityTaskEvent(replaced, first),
    replaced,
    "an older event leaves the array untouched, by reference",
  );
  assert.equal(
    upsertCommunityTaskEvent(replaced, newer),
    replaced,
    "a duplicate echo leaves the array untouched, by reference",
  );
  assert.equal(
    upsertCommunityTaskEvent(replaced, {
      ...newer,
      tags: [["d", "channel-sections"]],
    }),
    replaced,
    "foreign app data is never folded in",
  );
});

test("latestOwnCommunityTaskEventCreatedAt only looks at the signer's own events", () => {
  const events = [
    event(revision({ id: "card-1", eventCreatedAt: 100 })),
    // Bob's clock is far ahead; it must not drag Alice's next stamp along.
    event(revision({ id: "card-1", signer: BOB, eventCreatedAt: 999_999 })),
    event(revision({ id: "card-2", eventCreatedAt: 900 })),
  ];
  assert.equal(
    latestOwnCommunityTaskEventCreatedAt(events, "card-1", ALICE),
    100,
  );
  assert.equal(
    latestOwnCommunityTaskEventCreatedAt(events, "card-1", ALICE.toUpperCase()),
    100,
  );
  assert.equal(
    latestOwnCommunityTaskEventCreatedAt(events, "card-1", BOB),
    999_999,
  );
  assert.equal(
    latestOwnCommunityTaskEventCreatedAt(events, "card-1", CAROL),
    undefined,
  );
  assert.equal(
    latestOwnCommunityTaskEventCreatedAt(events, "card-9", ALICE),
    undefined,
  );
});

test("custom fields survive task content extraction and a moved revision; clear stays empty", () => {
  const customFields = [
    { id: "x", name: "Estimate", type: "number", value: 0 },
  ];
  const first = revision({ customFields });
  const task = resolveCommunityTaskLineage(ALICE, "card-1", [first]);
  const moved = revision({
    ...communityTaskContentOf(task),
    status: "doing",
    updatedAt: 101,
  });
  assert.deepEqual(
    resolveCommunityTaskLineage(ALICE, "card-1", [first, moved]).customFields,
    customFields,
  );
  const cleared = revision({
    ...moved.content,
    customFields: [],
    updatedAt: 102,
  });
  assert.deepEqual(
    communityTaskContentOf(
      resolveCommunityTaskLineage(ALICE, "card-1", [first, moved, cleared]),
    ).customFields,
    [],
  );
  const stranger = revision({ signer: MALLORY, customFields, updatedAt: 999 });
  assert.deepEqual(
    resolveCommunityTaskLineage(ALICE, "card-1", [first, cleared, stranger])
      .customFields,
    [],
  );
});

test("explicit document clear survives old relay replay and a subsequent status move", async () => {
  const { communityTaskContentOf } = await import("./communityTaskMerge.ts");
  const docs = [
    {
      pageId: "11111111-1111-4111-8111-111111111111",
      relayUrl: "wss://example.test",
      title: "Linked document",
    },
  ];
  const linked = event(revision({ documents: docs, updatedAt: 100 }));
  const cleared = event(revision({ documents: [], updatedAt: 200 }));
  let cache = upsertCommunityTaskEvent([linked], cleared);
  cache = upsertCommunityTaskEvent(cache, linked);
  assert.deepEqual(mergeCommunityTaskEvents(cache)[0].documents, []);
  const moved = event(
    revision({
      ...communityTaskContentOf(mergeCommunityTaskEvents(cache)[0]),
      status: "doing",
      updatedAt: 300,
    }),
  );
  const reconnected = mergeCommunityTaskEvents([moved]);
  assert.equal(reconnected[0].status, "doing");
  assert.deepEqual(reconnected[0].documents, []);
  assert.deepEqual(
    mergeCommunityTaskEvents([linked, cleared, moved])[0].documents,
    [],
  );
});
