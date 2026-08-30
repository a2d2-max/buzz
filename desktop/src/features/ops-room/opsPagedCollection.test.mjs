import assert from "node:assert/strict";
import { test } from "node:test";

import { OpsPageError } from "./opsBridge.ts";
import * as collection from "./opsPagedCollection.ts";

test("deduplicates an artifact page by immutable id, version, and representation", () => {
  const first = {
    id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "markdown",
    representation: "preview",
    status: "ready",
    title: "First",
    version: 1,
  };
  const secondVersion = { ...first, title: "Second version", version: 2 };

  assert.deepEqual(
    collection.mergeImmutableOpsPage([first], [first, secondVersion]),
    [first, secondVersion],
  );
});

const WORK_REQUEST = {
  module: "work_items",
  scope: { sort: "last_activity_at_desc" },
};
const item = (id) => ({
  id,
  project_id: "project:raou",
  title: `Work ${id}`,
  status: "active",
  progress: 0.5,
  last_activity_at: "2026-08-30T00:00:00Z",
  session_count: 1,
  approval_count: 0,
  artifact_count: 0,
});
const capabilities = (revision = 3, overrides = {}) => ({
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
  modules: [
    {
      name: "work_items",
      schema_version: 1,
      paged: true,
      collection_revision: revision,
      ...overrides,
    },
  ],
});
const ready = (items, nextCursor = null, revision = 3) => ({
  status: "ready",
  data: {
    contract_version: 1,
    revision,
    generated_at: "2026-08-30T00:00:00Z",
    items,
    next_cursor: nextCursor,
  },
});

function loaderWith(sequence, capabilitySequence = [capabilities()]) {
  const requests = [];
  const marked = [];
  let capabilityIndex = 0;
  return {
    dependencies: {
      getCapabilities: async () =>
        capabilitySequence[
          Math.min(capabilityIndex++, capabilitySequence.length - 1)
        ],
      loadModuleState: async (request) => {
        requests.push(request);
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      markContractInvalid: (module, caps) => marked.push({ module, caps }),
    },
    capabilityCalls: () => capabilityIndex,
    marked,
    requests,
  };
}

test("uses the captured advertised capability without a second initial probe", async () => {
  const harness = loaderWith(
    [ready([item("work:captured")])],
    [capabilities(9)],
  );
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
      capabilities(3),
    ),
    {
      status: "ready",
      items: [item("work:captured")],
      revision: 3,
      refreshed: false,
    },
  );
  assert.equal(harness.capabilityCalls(), 0);
});

test("loads every canonical page immutably until next_cursor is null", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const harness = loaderWith([
    ready([item("work:one")], "cursor:two"),
    ready([item("work:two")]),
  ]);
  const result = await collection.loadCompleteDormantOpsCollection(
    WORK_REQUEST,
    harness.dependencies,
  );
  assert.deepEqual(result, {
    status: "ready",
    items: [item("work:one"), item("work:two")],
    revision: 3,
    refreshed: false,
  });
  assert.deepEqual(
    harness.requests.map(({ cursor }) => cursor),
    [null, "cursor:two"],
  );
});

test("fails closed after 32 fresh-cursor pages without requesting page 33", async () => {
  const harness = loaderWith(
    Array.from({ length: 33 }, (_, index) =>
      ready(
        [item(`work:budget-${index + 1}`)],
        index === 32 ? null : `cursor:${index + 2}`,
      ),
    ),
  );

  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    { status: "contract_invalid" },
  );
  assert.equal(harness.requests.length, 32);
  assert.ok(harness.requests.every(({ page_size }) => page_size === 100));
  assert.equal(harness.marked.length, 1);
});

test("rejects a response page above 100 items without rendering a prefix", async () => {
  const harness = loaderWith([
    ready(Array.from({ length: 101 }, (_, index) => item(`work:${index}`))),
  ]);

  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    { status: "contract_invalid" },
  );
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.marked.length, 1);
});

test("accepts the exact 3,200-item aggregate boundary", async () => {
  const harness = loaderWith(
    Array.from({ length: 32 }, (_, pageIndex) =>
      ready(
        Array.from({ length: 100 }, (_, itemIndex) =>
          item(`work:${pageIndex}-${itemIndex}`),
        ),
        pageIndex === 31 ? null : `cursor:${pageIndex + 2}`,
      ),
    ),
  );

  const result = await collection.loadCompleteDormantOpsCollection(
    WORK_REQUEST,
    harness.dependencies,
  );
  assert.equal(result.status, "ready");
  assert.equal(result.items.length, 3200);
  assert.equal(harness.requests.length, 32);
  assert.equal(harness.marked.length, 0);
});

test("rejects duplicate public IDs across complete pages", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const harness = loaderWith([
    ready([item("work:one")], "cursor:two"),
    ready([item("work:one")]),
  ]);
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    { status: "contract_invalid" },
  );
  assert.equal(harness.marked.length, 1);
});

test("rejects cursor loops instead of issuing an unbounded request", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const harness = loaderWith([
    ready([item("work:one")], "cursor:loop"),
    ready([item("work:two")], "cursor:loop"),
  ]);
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    { status: "contract_invalid" },
  );
  assert.equal(harness.requests.length, 2);
});

test("one stale cursor restarts the whole collection with the new revision", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const harness = loaderWith(
    [
      ready([item("work:old")], "cursor:old"),
      new OpsPageError("stale_cursor"),
      ready([item("work:new")], null, 4),
    ],
    [capabilities(3), capabilities(4)],
  );
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    {
      status: "ready",
      items: [item("work:new")],
      revision: 4,
      refreshed: true,
      authoritativeCapabilities: capabilities(4),
    },
  );
});

test("a second stale cursor becomes visible retry_required", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const harness = loaderWith(
    [
      ready([item("work:old")], "cursor:old"),
      new OpsPageError("stale_cursor"),
      ready([item("work:new")], "cursor:new", 4),
      new OpsPageError("stale_cursor"),
    ],
    [capabilities(3), capabilities(4)],
  );
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      harness.dependencies,
    ),
    { status: "retry_required", refreshed: true },
  );
});

test("capability absence and route unavailable remain distinct from ready-empty", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  const absent = loaderWith([], [{ ...capabilities(), modules: [] }]);
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      absent.dependencies,
    ),
    { status: "unavailable" },
  );
  assert.equal(absent.requests.length, 0);

  const unavailable = loaderWith([{ status: "unavailable" }]);
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      unavailable.dependencies,
    ),
    { status: "unavailable" },
  );

  const empty = loaderWith([ready([])]);
  assert.deepEqual(
    await collection.loadCompleteDormantOpsCollection(
      WORK_REQUEST,
      empty.dependencies,
    ),
    { status: "ready", items: [], revision: 3, refreshed: false },
  );
});

test("advertised non-paged or revisionless modules are contract_invalid", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  for (const caps of [
    capabilities(3, { paged: false }),
    capabilities(3, { collection_revision: undefined }),
  ]) {
    const harness = loaderWith([], [caps]);
    assert.deepEqual(
      await collection.loadCompleteDormantOpsCollection(
        WORK_REQUEST,
        harness.dependencies,
      ),
      { status: "contract_invalid" },
    );
    assert.equal(harness.marked.length, 1);
  }
});

test("invalid cursor and malformed page isolation mark only that module invalid", async () => {
  assert.equal(typeof collection.loadCompleteDormantOpsCollection, "function");
  for (const failure of [
    new OpsPageError("invalid_cursor"),
    { status: "contract_invalid" },
  ]) {
    const harness = loaderWith([failure]);
    assert.deepEqual(
      await collection.loadCompleteDormantOpsCollection(
        WORK_REQUEST,
        harness.dependencies,
      ),
      { status: "contract_invalid" },
    );
    assert.equal(harness.marked.length, 1);
  }
});

test("capability revision is part of complete collection identity", () => {
  assert.equal(typeof collection.completeOpsCollectionKey, "function");
  assert.notDeepEqual(
    collection.completeOpsCollectionKey(WORK_REQUEST, 3),
    collection.completeOpsCollectionKey(WORK_REQUEST, 4),
  );
});
