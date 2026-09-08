import assert from "node:assert/strict";
import test from "node:test";

import { planDocPagePublish } from "./docPublishPlan.ts";

function version(id, eventId, overrides = {}) {
  return {
    id,
    author: "a".repeat(64),
    eventId,
    eventCreatedAt: 100,
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
