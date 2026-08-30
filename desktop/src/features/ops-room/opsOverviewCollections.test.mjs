import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadCompleteOpsOverviewCollection,
  opsOverviewCollectionQueryKey,
} from "./opsOverviewCollections.ts";
import { OpsBridgeContractError, OpsPageError } from "./opsBridge.ts";

const generated_at = "2026-08-30T10:00:00Z";

function capabilities(module, revision = 7) {
  return {
    contract_version: 1,
    reads: ["snapshot", "events", "artifact"],
    drafts: [],
    transitions: [],
    modules: module
      ? [
          {
            name: module,
            schema_version: 1,
            paged: true,
            collection_revision: revision,
          },
        ]
      : [],
  };
}

function page(revision, items, next_cursor = null) {
  return { contract_version: 1, revision, generated_at, items, next_cursor };
}

const research = {
  id: "research:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "Reader, Come Home",
  status: "complete",
  updated_at: generated_at,
};

test("absent overview capability is unavailable without invoking the page route", async () => {
  let pageCalls = 0;
  const result = await loadCompleteOpsOverviewCollection(
    {
      module: "research",
      scope: { sort: "created_at_desc" },
    },
    {
      getCapabilities: async () => capabilities(null),
      getPage: async () => {
        pageCalls += 1;
        return page(7, []);
      },
      markContractInvalid() {},
    },
  );

  assert.deepEqual(result, { status: "unavailable" });
  assert.equal(pageCalls, 0);
});

test("captured overview capabilities avoid a second initial capability probe", async () => {
  let probes = 0;
  const captured = capabilities("research", 7);
  const result = await loadCompleteOpsOverviewCollection(
    {
      module: "research",
      scope: { sort: "created_at_desc" },
    },
    {
      getCapabilities: async () => {
        probes += 1;
        return captured;
      },
      getPage: async () => page(7, [research]),
      markContractInvalid() {},
    },
    captured,
  );

  assert.equal(result.status, "ready");
  assert.equal(probes, 0);
});

test("advertised research unavailable and malformed overviews fail closed", async () => {
  const marked = [];
  const request = {
    module: "research",
    scope: { sort: "created_at_desc" },
  };
  const unavailable = await loadCompleteOpsOverviewCollection(request, {
    getCapabilities: async () => capabilities("research"),
    getPage: async () => {
      throw new OpsPageError("unavailable");
    },
    markContractInvalid(module) {
      marked.push(module);
    },
  });
  assert.deepEqual(unavailable, { status: "contract_invalid" });
  assert.deepEqual(marked, ["research"]);

  const invalid = await loadCompleteOpsOverviewCollection(request, {
    getCapabilities: async () => capabilities("research"),
    getPage: async () => {
      throw new OpsBridgeContractError();
    },
    markContractInvalid(module) {
      marked.push(module);
    },
  });
  assert.deepEqual(invalid, { status: "contract_invalid" });
  assert.deepEqual(marked, ["research", "research"]);
});

test("overview traversal restarts once from the new revision and exposes a second stale", async () => {
  const capabilityResults = [
    capabilities("research", 7),
    capabilities("research", 8),
  ];
  const requests = [];
  const result = await loadCompleteOpsOverviewCollection(
    {
      module: "research",
      scope: { sort: "created_at_desc" },
    },
    {
      getCapabilities: async () => capabilityResults.shift(),
      getPage: async (request, revision) => {
        requests.push({ cursor: request.cursor, revision });
        if (revision === 7) throw new OpsPageError("stale_cursor");
        return page(8, [research]);
      },
      markContractInvalid() {},
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.revision, 8);
  assert.equal(result.refreshed, true);
  assert.deepEqual(requests, [
    { cursor: null, revision: 7 },
    { cursor: null, revision: 8 },
  ]);

  let calls = 0;
  const raced = await loadCompleteOpsOverviewCollection(
    {
      module: "research",
      scope: { sort: "created_at_desc" },
    },
    {
      getCapabilities: async () => capabilities("research", 7 + calls),
      getPage: async () => {
        calls += 1;
        throw new OpsPageError("stale_cursor");
      },
      markContractInvalid() {},
    },
  );
  assert.deepEqual(raced, { status: "retry_required", refreshed: true });
  assert.equal(calls, 2);
});

test("overview query identity isolates module revision and scope", () => {
  assert.deepEqual(
    opsOverviewCollectionQueryKey(
      {
        module: "repositories",
        scope: { project: "project:raou", sort: "display_name_asc" },
      },
      19,
    ),
    [
      "ops",
      "overview",
      "repositories",
      19,
      { project: "project:raou", sort: "display_name_asc" },
    ],
  );
});

test("overview paging accumulates immutable IDs and rejects duplicate IDs, cursor loops, page overflow, and item overflow", async () => {
  const request = {
    module: "repositories",
    scope: { project: null, sort: "display_name_asc" },
  };
  const repository = (id) => ({
    id,
    name: id,
    branch: "main",
    clean: true,
    ahead: 0,
    behind: 0,
  });
  const repositoryCapabilities = capabilities("repositories", 11);
  const load = async (pages) => {
    const marked = [];
    let calls = 0;
    const result = await loadCompleteOpsOverviewCollection(request, {
      getCapabilities: async () => repositoryCapabilities,
      getPage: async () => pages[calls++],
      markContractInvalid(module) {
        marked.push(module);
      },
    });
    return { calls, marked, result };
  };

  const complete = await load([
    page(11, [repository("repository:a")], "next"),
    page(11, [repository("repository:b")]),
  ]);
  assert.equal(complete.calls, 2);
  assert.deepEqual(
    complete.result.items.map(({ id }) => id),
    ["repository:a", "repository:b"],
  );

  for (const pages of [
    [
      page(11, [repository("repository:a")], "next"),
      page(11, [repository("repository:a")]),
    ],
    [page(11, [], "next"), page(11, [], "next")],
    [
      page(
        11,
        Array.from({ length: 101 }, (_, index) =>
          repository(`repository:${index}`),
        ),
      ),
    ],
  ]) {
    const invalid = await load(pages);
    assert.deepEqual(invalid.result, { status: "contract_invalid" });
    assert.deepEqual(invalid.marked, ["repositories"]);
  }

  const endless = Array.from({ length: 32 }, (_, index) =>
    page(11, [], `cursor-${index}`),
  );
  const bounded = await load(endless);
  assert.equal(bounded.calls, 32);
  assert.deepEqual(bounded.result, { status: "contract_invalid" });
  assert.deepEqual(bounded.marked, ["repositories"]);
});
