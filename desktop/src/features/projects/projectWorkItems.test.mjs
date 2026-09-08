import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchProjectsWorkItems,
  projectsWithWorkItemRepositories,
} from "./projectWorkItems.ts";

// ── Work-item deduplication ─────────────────────────────────────────────────
//
// NIP-MP §Multiple membership: a repository may belong to several projects.
// When it does, global issue/PR lists must produce exactly one row per work
// item — not one row per project membership. These tests call the exported
// production function with a stubbed fetchEvents to verify the dedup contract
// end-to-end, not just the filter algorithm in isolation.

const REPO_OWNER = "a".repeat(64);
const REPO_DTAG = "relay";
const REPO_ADDRESS = `30617:${REPO_OWNER}:${REPO_DTAG}`;

const ISSUE_ID = "i".repeat(64);
const PR_ID = "p".repeat(64);
const PR_ID_2 = "q".repeat(64);

// Two projects that both contain the same repository.
const projectA = {
  repositories: [{ repoAddress: REPO_ADDRESS }],
};
const projectB = {
  repositories: [{ repoAddress: REPO_ADDRESS }],
};

test("work-item scope keeps explicit and repository-only read models", () => {
  const explicitProject = {
    id: "explicit",
    legacy: false,
    repositories: [{ repoAddress: REPO_ADDRESS }],
  };
  const repositoryOnlyProject = {
    id: "repository-only",
    legacy: true,
    repositories: [{ repoAddress: `30617:${REPO_OWNER}:standalone` }],
  };
  const emptyProject = { id: "empty", legacy: false, repositories: [] };

  assert.deepEqual(
    projectsWithWorkItemRepositories([
      explicitProject,
      repositoryOnlyProject,
      emptyProject,
    ]).map((project) => project.id),
    ["explicit", "repository-only"],
  );
});

// Minimal valid NIP-34 issue event for the shared repo.
function makeIssue(id, updatedAt = 100, repoAddress = REPO_ADDRESS) {
  return {
    id,
    kind: 1621,
    pubkey: REPO_OWNER,
    created_at: updatedAt,
    content: "An issue",
    tags: [
      ["a", repoAddress],
      ["subject", "Fix the thing"],
    ],
  };
}

test("fetchProjectsWorkItems accumulates issues from every project repository", async () => {
  const secondAddress = `30617:${REPO_OWNER}:desktop`;
  const project = {
    repositories: [
      { repoAddress: REPO_ADDRESS },
      { repoAddress: secondAddress },
    ],
  };
  const result = await fetchProjectsWorkItems(
    [project],
    makeFetchEvents([
      makeIssue(ISSUE_ID, 100, REPO_ADDRESS),
      makeIssue("j".repeat(64), 90, secondAddress),
    ]),
  );

  assert.deepEqual(
    result.issues.items.map(({ repository }) => repository.repoAddress).sort(),
    [REPO_ADDRESS, secondAddress].sort(),
  );
});

// Minimal valid NIP-34 pull request event for the shared repo.
function makePR(id, updatedAt = 100) {
  return {
    id,
    kind: 1618, // KIND_GIT_PULL_REQUEST
    pubkey: REPO_OWNER,
    created_at: updatedAt,
    content: "A PR",
    tags: [
      ["a", REPO_ADDRESS],
      ["subject", "Add a feature"],
    ],
  };
}

// fetchEvents stub: returns the given root events (issues + PRs) and empty
// arrays for all other query kinds (updates, comments, statuses).
function makeFetchEvents(rootEvents) {
  return async (filter) => {
    const { kinds } = filter;
    // Root issues (kind 1621) + PRs (kind 1618)
    if (kinds?.includes(1621) || kinds?.includes(1618)) {
      return rootEvents.filter((e) => kinds.includes(e.kind));
    }
    // Everything else (PR updates, comments, statuses) — empty
    return [];
  };
}

test("fetchProjectsWorkItems deduplicates issues from a shared repository", async () => {
  const issue = makeIssue(ISSUE_ID);
  const fetchEvents = makeFetchEvents([issue]);

  const result = await fetchProjectsWorkItems(
    [projectA, projectB],
    fetchEvents,
  );

  assert.equal(
    result.issues.items.length,
    1,
    "duplicate issue from shared repo must collapse to one row",
  );
  assert.equal(result.issues.items[0].issue.id, ISSUE_ID);
});

test("fetchProjectsWorkItems deduplicates pull requests from a shared repository", async () => {
  const pr1 = makePR(PR_ID, 100);
  const pr2 = makePR(PR_ID_2, 90);
  const fetchEvents = makeFetchEvents([pr1, pr2]);

  const result = await fetchProjectsWorkItems(
    [projectA, projectB],
    fetchEvents,
  );

  assert.equal(
    result.pullRequests.items.length,
    2,
    "distinct PRs must survive dedup; only exact-id duplicates collapse",
  );
  const ids = result.pullRequests.items.map((item) => item.pullRequest.id);
  assert.ok(ids.includes(PR_ID), "first PR must be present");
  assert.ok(ids.includes(PR_ID_2), "second PR must be present");
});

test("fetchProjectsWorkItems returns a single row for a PR present in both project contexts", async () => {
  // Same PR id returned twice (once per project's relay query).
  const pr = makePR(PR_ID, 100);
  // The stub returns the same event for every root query, simulating
  // the relay returning the same PR for both projects' repo addresses.
  let callCount = 0;
  const fetchEvents = async (filter) => {
    if (filter.kinds?.includes(1618)) {
      callCount += 1;
      return [pr];
    }
    return [];
  };

  const result = await fetchProjectsWorkItems(
    [projectA, projectB],
    fetchEvents,
  );

  // The relay was queried once per unique repo address — but even if it
  // returned the same id twice across the two project contexts, dedupe fires.
  assert.equal(
    result.pullRequests.items.length,
    1,
    "same PR id appearing in both project contexts must produce one row",
  );
  // Sanity: the stub was actually called (proves we ran the production path).
  assert.ok(callCount >= 1, "fetchEvents must have been called");
});

// ── Status events ───────────────────────────────────────────────────────────
//
// The relay post-filters `#a` AFTER its SQL LIMIT, so a status fetch bounded
// by repo address silently truncates in a busy community — and a root whose
// status was cut off falls back to its labels (usually Backlog). Statuses are
// therefore walked by root id (`#e`), the one tag constraint pushed into SQL.

const STATUS_KINDS = [1630, 1631, 1632, 1633];

function makeStatus(id, rootId, kind, createdAt) {
  return {
    id,
    kind,
    pubkey: REPO_OWNER,
    created_at: createdAt,
    content: "",
    tags: [
      ["e", rootId, "", "root"],
      ["a", REPO_ADDRESS],
    ],
  };
}

test("statuses are fetched by root id for issues and pull requests alike", async () => {
  const statusFilters = [];
  const fetchEvents = async (filter) => {
    if (filter.kinds?.includes(1621)) {
      return [makeIssue(ISSUE_ID), makePR(PR_ID)];
    }
    if (STATUS_KINDS.some((kind) => filter.kinds?.includes(kind))) {
      statusFilters.push(filter);
      return [
        makeStatus("s".repeat(64), ISSUE_ID, 1631, 200),
        makeStatus("t".repeat(64), PR_ID, 1631, 200),
      ];
    }
    return [];
  };

  const result = await fetchProjectsWorkItems([projectA], fetchEvents);

  assert.equal(statusFilters.length, 1, "one exhaustive walk, no repo window");
  assert.deepEqual(
    [...statusFilters[0]["#e"]].sort(),
    [ISSUE_ID, PR_ID].sort(),
  );
  assert.equal(statusFilters[0]["#a"], undefined, "#a is post-filtered");
  assert.deepEqual(statusFilters[0].kinds, STATUS_KINDS);
  assert.equal(result.issues.items[0].issue.status, "Done");
  assert.equal(result.pullRequests.items[0].pullRequest.status, "Merged");
  assert.deepEqual(result.issues.failedSections, []);
});

test("a failed status walk surfaces as a failed statuses section", async () => {
  const fetchEvents = async (filter) => {
    if (filter.kinds?.includes(1621)) return [makeIssue(ISSUE_ID)];
    if (STATUS_KINDS.some((kind) => filter.kinds?.includes(kind))) {
      throw new Error("relay went away");
    }
    return [];
  };

  const result = await fetchProjectsWorkItems([projectA], fetchEvents);

  assert.equal(result.issues.items.length, 1, "roots still render");
  assert.ok(result.issues.failedSections.includes("statuses"));
  assert.ok(result.pullRequests.failedSections.includes("statuses"));
});
