import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDocPageVersion,
  buildDocTree,
  collectDescendantIds,
  flattenDocTree,
  nextDocEventCreatedAt,
  nextOrderAfter,
  pickLatestDocPages,
  reorderedSiblingOrder,
} from "./docTree.ts";

function makePage(id, overrides = {}) {
  return {
    id,
    author: "a".repeat(64),
    eventId: `${id}-event`,
    eventCreatedAt: 100,
    title: id,
    body: "",
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    deleted: false,
    ...overrides,
  };
}

const titles = (nodes) => nodes.map((node) => node.page.title);

// ── pickLatestDocPages ───────────────────────────────────────────────────────

test("pickLatestDocPages: newest event wins per page id, regardless of input order", () => {
  const older = makePage("p1", {
    title: "old",
    eventCreatedAt: 100,
    eventId: "e1",
  });
  const newer = makePage("p1", {
    title: "new",
    eventCreatedAt: 200,
    eventId: "e2",
  });
  assert.equal(pickLatestDocPages([older, newer]).get("p1")?.title, "new");
  assert.equal(pickLatestDocPages([newer, older]).get("p1")?.title, "new");
});

test("pickLatestDocPages: created_at tie breaks on the larger event id", () => {
  const a = makePage("p1", {
    title: "a",
    eventCreatedAt: 100,
    eventId: "aaaa",
  });
  const b = makePage("p1", {
    title: "b",
    eventCreatedAt: 100,
    eventId: "bbbb",
  });
  assert.equal(pickLatestDocPages([a, b]).get("p1")?.title, "b");
  assert.equal(pickLatestDocPages([b, a]).get("p1")?.title, "b");
});

test("pickLatestDocPages: a newer tombstone from another author supersedes the page", () => {
  const page = makePage("p1", { eventCreatedAt: 100 });
  const tombstone = makePage("p1", {
    author: "b".repeat(64),
    eventCreatedAt: 101,
    deleted: true,
  });
  assert.equal(pickLatestDocPages([page, tombstone]).get("p1")?.deleted, true);
});

// ── buildDocTree ─────────────────────────────────────────────────────────────

test("buildDocTree: nests children under parents and sorts siblings by order, title, id", () => {
  const tree = buildDocTree([
    makePage("root-b", { title: "Beta", order: 1 }),
    makePage("root-a", { title: "Alpha", order: 1 }),
    makePage("root-z", { title: "Zed", order: 0 }),
    makePage("child-2", { title: "Second", parentId: "root-a", order: 2 }),
    makePage("child-1", { title: "First", parentId: "root-a", order: 1 }),
    makePage("grandchild", { title: "Deep", parentId: "child-1" }),
  ]);
  assert.deepEqual(titles(tree), ["Zed", "Alpha", "Beta"]);
  const alpha = tree[1];
  assert.deepEqual(titles(alpha.children), ["First", "Second"]);
  assert.deepEqual(titles(alpha.children[0].children), ["Deep"]);
  assert.equal(alpha.depth, 0);
  assert.equal(alpha.children[0].depth, 1);
  assert.equal(alpha.children[0].children[0].depth, 2);
});

test("buildDocTree: same order and title falls back to id for a stable sort", () => {
  const tree = buildDocTree([
    makePage("b", { title: "Same" }),
    makePage("a", { title: "Same" }),
  ]);
  assert.deepEqual(
    tree.map((node) => node.page.id),
    ["a", "b"],
  );
});

test("buildDocTree: tombstones are dropped and their children surface at the root", () => {
  const tree = buildDocTree([
    makePage("gone", { title: "Gone", deleted: true }),
    makePage("orphan", { title: "Orphan", parentId: "gone" }),
    makePage("kept", { title: "Kept" }),
  ]);
  assert.deepEqual(titles(tree), ["Kept", "Orphan"]);
});

test("buildDocTree: unknown parent id attaches the page at the root", () => {
  const tree = buildDocTree([
    makePage("lost", { title: "Lost", parentId: "never-published" }),
  ]);
  assert.deepEqual(titles(tree), ["Lost"]);
});

test("buildDocTree: a two-page cycle is broken at the smallest id and both pages stay visible", () => {
  const tree = buildDocTree([
    makePage("b", { title: "B", parentId: "a" }),
    makePage("a", { title: "A", parentId: "b" }),
  ]);
  assert.deepEqual(titles(tree), ["A"]);
  assert.deepEqual(titles(tree[0].children), ["B"]);
});

test("buildDocTree: a page hanging off a cycle keeps its parent link", () => {
  const tree = buildDocTree([
    makePage("c", { title: "C", parentId: "b" }),
    makePage("b", { title: "B", parentId: "a" }),
    makePage("a", { title: "A", parentId: "c" }),
    makePage("leaf", { title: "Leaf", parentId: "b" }),
    makePage("solo", { title: "Solo" }),
  ]);
  assert.deepEqual(titles(tree), ["A", "Solo"]);
  // a is the cycle root; b keeps parent a; c and leaf keep parent b.
  const a = tree[0];
  assert.deepEqual(titles(a.children), ["B"]);
  assert.deepEqual(titles(a.children[0].children), ["C", "Leaf"]);
  assert.deepEqual(titles(a.children[0].children[0].children), []);
});

test("buildDocTree: accepts the map produced by pickLatestDocPages", () => {
  const latest = pickLatestDocPages([
    makePage("p", { title: "v1", eventCreatedAt: 1 }),
    makePage("p", { title: "v2", eventCreatedAt: 2 }),
  ]);
  assert.deepEqual(titles(buildDocTree(latest.values())), ["v2"]);
});

// ── flattenDocTree / collectDescendantIds / nextSiblingOrder ────────────────

test("flattenDocTree: depth-first order with depth preserved", () => {
  const tree = buildDocTree([
    makePage("a", { title: "A", order: 0 }),
    makePage("a1", { title: "A1", parentId: "a" }),
    makePage("a1x", { title: "A1x", parentId: "a1" }),
    makePage("b", { title: "B", order: 1 }),
  ]);
  const flat = flattenDocTree(tree);
  assert.deepEqual(
    flat.map((node) => [node.page.title, node.depth]),
    [
      ["A", 0],
      ["A1", 1],
      ["A1x", 2],
      ["B", 0],
    ],
  );
});

test("collectDescendantIds: every id below the target, not the target itself", () => {
  const tree = buildDocTree([
    makePage("a", { title: "A" }),
    makePage("a1", { parentId: "a" }),
    makePage("a1x", { parentId: "a1" }),
    makePage("b", { title: "B" }),
  ]);
  assert.deepEqual([...collectDescendantIds(tree, "a")].sort(), ["a1", "a1x"]);
  assert.deepEqual([...collectDescendantIds(tree, "b")], []);
  assert.deepEqual([...collectDescendantIds(tree, "missing")], []);
});

test("nextOrderAfter: 0 for an empty level, max + 1 otherwise, ignoring tombstones", () => {
  const level = [
    makePage("r1", { order: 4 }),
    makePage("r2", { order: 9, deleted: true }),
    // An orphan surfaced at the root still counts as a root sibling, even
    // though its stored parentId points at a deleted page.
    makePage("orphan", { parentId: "gone", order: 6 }),
  ];
  assert.equal(nextOrderAfter(level), 7);
  assert.equal(nextOrderAfter([]), 0);
});

// ── applyDocPageVersion / nextDocEventCreatedAt / reorderedSiblingOrder ─────

test("applyDocPageVersion: newer version replaces, producing a new map", () => {
  const before = new Map([
    ["p", makePage("p", { title: "v1", eventCreatedAt: 1 })],
  ]);
  const after = applyDocPageVersion(
    before,
    makePage("p", { title: "v2", eventCreatedAt: 2 }),
  );
  assert.notEqual(after, before, "a change must produce a fresh map");
  assert.equal(after.get("p")?.title, "v2");
  assert.equal(before.get("p")?.title, "v1", "input map is not mutated");
});

test("applyDocPageVersion: stale or duplicate version returns the same map instance", () => {
  const current = makePage("p", {
    title: "v2",
    eventCreatedAt: 2,
    eventId: "e2",
  });
  const before = new Map([["p", current]]);
  assert.equal(
    applyDocPageVersion(
      before,
      makePage("p", { title: "v1", eventCreatedAt: 1 }),
    ),
    before,
  );
  assert.equal(applyDocPageVersion(before, current), before);
});

test("applyDocPageVersion: unknown page id is added", () => {
  const after = applyDocPageVersion(new Map(), makePage("fresh"));
  assert.equal(after.get("fresh")?.id, "fresh");
});

test("nextDocEventCreatedAt: now, unless a known version is at or ahead of it", () => {
  assert.equal(nextDocEventCreatedAt(1_000, undefined), 1_000);
  assert.equal(nextDocEventCreatedAt(1_000, 900), 1_000);
  assert.equal(nextDocEventCreatedAt(1_000, 1_000), 1_001);
  assert.equal(nextDocEventCreatedAt(1_000, 1_200), 1_201);
});

test("nextDocEventCreatedAt: stays inside the relay's drift window", () => {
  // The relay rejects |created_at - server now| > 900 s. The default allowance
  // is 840 s: 900 minus a margin for the client clock running ahead.
  assert.equal(nextDocEventCreatedAt(1_000, 1_839), 1_840);
  assert.equal(nextDocEventCreatedAt(1_000, 1_840), null);
  assert.equal(nextDocEventCreatedAt(1_000, 5_000), null);
  assert.equal(
    nextDocEventCreatedAt(1_000, 1_050, 10),
    null,
    "custom allowance",
  );
});

test("reorderedSiblingOrder: moving up lands strictly before the previous sibling", () => {
  const siblings = [
    makePage("s0", { order: 0 }),
    makePage("s1", { order: 2 }),
    makePage("s2", { order: 4 }),
  ];
  assert.equal(
    reorderedSiblingOrder(siblings, 0, -1),
    null,
    "top cannot move up",
  );
  assert.equal(
    reorderedSiblingOrder(siblings, 1, -1),
    -1,
    "above the first sibling",
  );
  assert.equal(
    reorderedSiblingOrder(siblings, 2, -1),
    1,
    "midpoint of s0 and s1",
  );
});

test("reorderedSiblingOrder: moving down lands strictly after the next sibling", () => {
  const siblings = [
    makePage("s0", { order: 0 }),
    makePage("s1", { order: 2 }),
    makePage("s2", { order: 4 }),
  ];
  assert.equal(
    reorderedSiblingOrder(siblings, 2, 1),
    null,
    "bottom cannot move down",
  );
  assert.equal(
    reorderedSiblingOrder(siblings, 1, 1),
    5,
    "below the last sibling",
  );
  assert.equal(
    reorderedSiblingOrder(siblings, 0, 1),
    3,
    "midpoint of s1 and s2",
  );
});

test("reorderedSiblingOrder: colliding orders step past the whole run of equal neighbours", () => {
  const siblings = [
    makePage("s0", { order: 1 }),
    makePage("s1", { order: 1 }),
    makePage("s2", { order: 1 }),
  ];
  const up = reorderedSiblingOrder(siblings, 2, -1);
  assert.ok(up !== null && up < 1, "must sort before s1");
  const down = reorderedSiblingOrder(siblings, 0, 1);
  assert.ok(down !== null && down > 1, "must sort after s1");
});

// ── findDocTreeSiblings / findDocTreePath ───────────────────────────────────

test("findDocTreeSiblings: the rendered level containing the page (roots for a root)", async () => {
  const { findDocTreeSiblings } = await import("./docTree.ts");
  const tree = buildDocTree([
    makePage("a", { title: "A", order: 0 }),
    makePage("b", { title: "B", order: 1 }),
    makePage("a1", { title: "A1", parentId: "a", order: 0 }),
    makePage("a2", { title: "A2", parentId: "a", order: 1 }),
  ]);
  assert.deepEqual(titles(findDocTreeSiblings(tree, "b") ?? []), ["A", "B"]);
  assert.deepEqual(titles(findDocTreeSiblings(tree, "a2") ?? []), ["A1", "A2"]);
  assert.equal(findDocTreeSiblings(tree, "missing"), null);
});

test("findDocTreePath: ancestors from the root down to the page itself", async () => {
  const { findDocTreePath } = await import("./docTree.ts");
  const tree = buildDocTree([
    makePage("a", { title: "A" }),
    makePage("a1", { title: "A1", parentId: "a" }),
    makePage("a1x", { title: "A1x", parentId: "a1" }),
  ]);
  assert.deepEqual(
    findDocTreePath(tree, "a1x").map((page) => page.title),
    ["A", "A1", "A1x"],
  );
  assert.deepEqual(findDocTreePath(tree, "missing"), []);
});
