import assert from "node:assert/strict";
import test from "node:test";

import {
  canMoveCommunityIssue,
  communityIssueMoveSignsAsManagedOwner,
} from "./communityIssuePermissions.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const STRANGER = "c".repeat(64);
const AGENT = "d".repeat(64);

function item(overrides = {}) {
  return {
    issue: { author: AUTHOR, id: "e".repeat(64) },
    project: { owner: OWNER, repoAddress: `30617:${OWNER}:demo` },
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    item: item(),
    managedAgentPubkeys: new Set(),
    statusesUnavailable: false,
    viewer: STRANGER,
    ...overrides,
  };
}

test("the task author may move their own card", () => {
  assert.equal(canMoveCommunityIssue(input({ viewer: AUTHOR })), true);
});

test("the repository owner may move any card in that repository", () => {
  assert.equal(canMoveCommunityIssue(input({ viewer: OWNER })), true);
});

test("the owner of a managed agent that owns the repository may move its cards", () => {
  assert.equal(
    canMoveCommunityIssue(
      input({
        item: item({ project: { owner: AGENT, repoAddress: "x" } }),
        managedAgentPubkeys: new Set([AGENT]),
        viewer: STRANGER,
      }),
    ),
    true,
  );
});

test("pubkeys are compared case-insensitively on every path", () => {
  assert.equal(
    canMoveCommunityIssue(
      input({
        item: item({ issue: { author: AUTHOR.toUpperCase(), id: "e" } }),
        viewer: AUTHOR,
      }),
    ),
    true,
    "author",
  );
  assert.equal(
    canMoveCommunityIssue(
      input({
        item: item({ project: { owner: OWNER.toUpperCase() } }),
        viewer: OWNER,
      }),
    ),
    true,
    "owner",
  );
  assert.equal(
    canMoveCommunityIssue(
      input({
        item: item({ project: { owner: AGENT.toUpperCase() } }),
        managedAgentPubkeys: new Set([AGENT]),
      }),
    ),
    true,
    "managed agent owner",
  );
});

test("anyone else, or nobody at all, may not move a card", () => {
  assert.equal(canMoveCommunityIssue(input({ viewer: STRANGER })), false);
  assert.equal(canMoveCommunityIssue(input({ viewer: null })), false);
});

test("nobody may move a card while task statuses are missing", () => {
  // A drop would publish an authoritative status over one the viewer never
  // saw — a closed task shown in its label-derived Backlog column would be
  // "reopened" by dragging it to Triage.
  for (const viewer of [AUTHOR, OWNER]) {
    assert.equal(
      canMoveCommunityIssue(input({ statusesUnavailable: true, viewer })),
      false,
      viewer,
    );
  }
  assert.equal(
    canMoveCommunityIssue(
      input({
        item: item({ project: { owner: AGENT } }),
        managedAgentPubkeys: new Set([AGENT]),
        statusesUnavailable: true,
      }),
    ),
    false,
    "managed agent owner",
  );
});

test("a move signs as the managed owner only when the viewer is not that owner", () => {
  const managed = new Set([AGENT]);
  const agentRepo = item({ project: { owner: AGENT } });
  assert.equal(
    communityIssueMoveSignsAsManagedOwner({
      item: agentRepo,
      managedAgentPubkeys: managed,
      viewer: STRANGER,
    }),
    true,
  );
  assert.equal(
    communityIssueMoveSignsAsManagedOwner({
      item: agentRepo,
      managedAgentPubkeys: managed,
      viewer: AGENT,
    }),
    false,
    "the agent itself signs directly",
  );
  assert.equal(
    communityIssueMoveSignsAsManagedOwner({
      item: item(),
      managedAgentPubkeys: managed,
      viewer: OWNER,
    }),
    false,
    "a repository no managed agent owns",
  );
});
