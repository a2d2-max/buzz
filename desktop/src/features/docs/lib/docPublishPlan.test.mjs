import assert from "node:assert/strict";
import test from "node:test";

import { planDocPagePublish } from "./docPublishPlan.ts";

function version(id, eventId, overrides = {}) {
  return {
    id,
    author: "a".repeat(64),
    eventId,
    eventCreatedAt: 100,
    eventKind: 30623,
    title: "T",
    body: "body",
    parentId: null,
    order: 0,
    createdAt: 1,
    updatedAt: 2,
    deleted: false,
    ...overrides,
  };
}

const NEXT = {
  id: "p",
  title: "T",
  body: "body",
  parentId: null,
  order: 0,
  createdAt: 1,
  updatedAt: 3,
};

test("publish when there is no known version at all", () => {
  assert.deepEqual(planDocPagePublish({ newest: undefined, next: NEXT }), {
    kind: "publish",
    content: NEXT,
  });
});

test("conflict when the save was based on an older version than the newest", () => {
  const newest = version("p", "v2", { body: "theirs" });
  assert.deepEqual(
    planDocPagePublish({ newest, next: NEXT, baseEventId: "v1" }),
    { kind: "conflict", newest },
  );
});

test("publish when the save was based on the newest version", () => {
  const newest = version("p", "v2");
  const next = { ...NEXT, title: "mine" };
  assert.deepEqual(planDocPagePublish({ newest, next, baseEventId: "v2" }), {
    kind: "publish",
    content: next,
  });
});

test("noop when nothing visible changed, even without a base", () => {
  const newest = version("p", "v2");
  assert.deepEqual(planDocPagePublish({ newest, next: NEXT }), {
    kind: "noop",
    newest,
  });
});

test("identical content on top of a legacy-kind version is a publish, not a noop", () => {
  // The republish is what migrates the page off the shared 30078 window; a
  // noop here would strand untouched pages on the legacy kind forever.
  const newest = version("p", "v2", { eventKind: 30078 });
  assert.deepEqual(planDocPagePublish({ newest, next: NEXT }), {
    kind: "publish",
    content: NEXT,
  });
});

test("on a relay that rejects 30623, identical content on a legacy version is a noop again", () => {
  // There is nowhere to migrate to: forcing a publish would stack identical
  // dead versions on the shared 30078 window on every touch.
  const newest = version("p", "v2", { eventKind: 30078 });
  assert.deepEqual(
    planDocPagePublish({ dedicatedKindSupported: false, newest, next: NEXT }),
    { kind: "noop", newest },
  );
  // A real change still publishes.
  assert.equal(
    planDocPagePublish({
      dedicatedKindSupported: false,
      newest,
      next: { ...NEXT, title: "changed" },
    }).kind,
    "publish",
  );
});

test("a conflict still wins over migration on a legacy-kind version", () => {
  const newest = version("p", "v2", { eventKind: 30078 });
  assert.equal(
    planDocPagePublish({ newest, next: NEXT, baseEventId: "v1" }).kind,
    "conflict",
  );
});

test("restoring a tombstone is a change, not a noop", () => {
  const newest = version("p", "v2", { deleted: true });
  assert.equal(planDocPagePublish({ newest, next: NEXT }).kind, "publish");
});

test("a base is compared even when content happens to match", () => {
  // Same text as the newest version but based on an older one: still a
  // conflict, so the author learns someone else already made that edit.
  const newest = version("p", "v2");
  assert.equal(
    planDocPagePublish({ newest, next: NEXT, baseEventId: "v1" }).kind,
    "conflict",
  );
});

test("AFFiNE conversion cannot flatten an existing linked database", () => {
  const newest = version("p", "v2", {
    body: "# Linked data\n\n:::db 11111111-2222-4333-8444-555555555555 board",
  });
  assert.throws(
    () =>
      planDocPagePublish({
        newest,
        baseEventId: newest.eventId,
        next: {
          ...NEXT,
          body: "Linked data",
          affine: { version: 1, data: "AQID" },
        },
      }),
    /linked databases/i,
  );
  assert.equal(
    planDocPagePublish({
      newest,
      next: { ...NEXT, body: newest.body, order: 2 },
    }).kind,
    "publish",
  );
});

test("linked DB capable editor converts only when every existing reference survives", () => {
  const body = ":::db 11111111-2222-4333-8444-555555555555 board";
  const newest = version("p", "base", { body });
  assert.equal(
    planDocPagePublish({
      newest,
      baseEventId: "base",
      next: { ...NEXT, body, affine: { version: 2, data: "AQID" } },
    }).kind,
    "publish",
  );
  assert.throws(
    () =>
      planDocPagePublish({
        newest,
        next: { ...NEXT, body: "lost", affine: { version: 2, data: "AQID" } },
      }),
    /linked database/i,
  );
  assert.throws(
    () =>
      planDocPagePublish({
        newest,
        next: {
          ...NEXT,
          body: body.replace(" board", " table"),
          affine: { version: 2, data: "AQID" },
        },
      }),
    /linked database/i,
  );
  assert.throws(
    () =>
      planDocPagePublish({
        newest,
        next: { ...NEXT, body, affine: { version: 1, data: "AQID" } },
      }),
    /linked database/i,
  );
});
