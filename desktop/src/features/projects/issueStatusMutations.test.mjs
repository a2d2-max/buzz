import assert from "node:assert/strict";
import test from "node:test";

import {
  projectIssueStatusEvent,
  updateProjectIssueStatus,
} from "./issueStatusMutations.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const ISSUE_ID = "d".repeat(64);

const project = {
  id: `30617:${OWNER}:buzz`,
  owner: OWNER,
  repoAddress: `30617:${OWNER}:buzz`,
};

function issue(overrides = {}) {
  return {
    id: ISSUE_ID,
    author: AUTHOR,
    status: "Backlog",
    statusCreatedAt: null,
    ...overrides,
  };
}

function installTauriInvoke(handler) {
  globalThis.window ??= {};
  window.__TAURI_INTERNALS__ = { invoke: handler };
}

test("each droppable column publishes its own status kind and word", () => {
  const cases = [
    ["Backlog", 1630, "open"],
    ["Triage", 1633, "draft"],
    ["Done", 1631, "resolved"],
    ["Closed", 1632, "closed"],
  ];
  for (const [status, kind, word] of cases) {
    const event = projectIssueStatusEvent(project, issue(), status, 1_700);
    assert.equal(event.kind, kind, status);
    assert.equal(event.word, word, status);
  }
});

test("a label-only column cannot be published", () => {
  for (const status of ["In Progress", "In Review"]) {
    assert.throws(
      () => projectIssueStatusEvent(project, issue(), status, 1_700),
      /cannot be published/,
      status,
    );
  }
});

test("status tags name the root, the repo, the owner and the task author", () => {
  const event = projectIssueStatusEvent(project, issue(), "Done", 1_700);

  assert.deepEqual(event.tags, [
    ["e", ISSUE_ID, "", "root"],
    ["a", project.repoAddress],
    ["p", OWNER],
    ["p", AUTHOR],
  ]);
});

test("an owner-authored task is tagged once, not twice", () => {
  const event = projectIssueStatusEvent(
    project,
    issue({ author: OWNER.toUpperCase() }),
    "Closed",
    1_700,
  );

  assert.deepEqual(event.tags, [
    ["e", ISSUE_ID, "", "root"],
    ["a", project.repoAddress],
    ["p", OWNER],
  ]);
});

test("createdAt outranks the previous status event", () => {
  assert.equal(
    projectIssueStatusEvent(project, issue(), "Done", 1_700).createdAt,
    1_700,
  );
  assert.equal(
    projectIssueStatusEvent(
      project,
      issue({ statusCreatedAt: 1_700 }),
      "Done",
      1_700,
    ).createdAt,
    1_701,
  );
});

test("the managed-owner path hands the whole write to the Tauri command", async (t) => {
  const prior = globalThis.window;
  t.after(() => {
    globalThis.window = prior;
  });
  const calls = [];
  installTauriInvoke((command, args) => {
    calls.push([command, args]);
    return Promise.resolve(null);
  });

  await updateProjectIssueStatus({
    issue: issue({ statusCreatedAt: 4_000_000_000 }),
    project,
    signAsManagedOwner: true,
    status: "Closed",
  });

  assert.equal(calls.length, 1);
  const [command, args] = calls[0];
  assert.equal(command, "sign_project_issue_status");
  assert.deepEqual(args.input, {
    targetOwner: OWNER,
    repoAddress: project.repoAddress,
    issueId: ISSUE_ID,
    issueAuthor: AUTHOR,
    status: "closed",
    createdAt: 4_000_000_001,
  });
});

test("the normal path signs the status event itself", async (t) => {
  const prior = globalThis.window;
  t.after(() => {
    globalThis.window = prior;
  });
  const calls = [];
  installTauriInvoke((command, args) => {
    calls.push([command, args]);
    // Fail at the signing step so the test never reaches the live relay.
    return Promise.reject(new Error("no signer in tests"));
  });

  await assert.rejects(
    updateProjectIssueStatus({
      issue: issue({ statusCreatedAt: 4_000_000_000 }),
      project,
      signAsManagedOwner: false,
      status: "Triage",
    }),
    /no signer in tests/,
  );

  assert.equal(calls.length, 1);
  const [command, args] = calls[0];
  assert.equal(command, "sign_event");
  assert.equal(args.kind, 1633);
  assert.equal(args.content, "");
  assert.equal(args.createdAt, 4_000_000_001);
  assert.deepEqual(args.tags, [
    ["e", ISSUE_ID, "", "root"],
    ["a", project.repoAddress],
    ["p", OWNER],
    ["p", AUTHOR],
  ]);
});
