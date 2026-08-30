import assert from "node:assert/strict";
import { test } from "node:test";

const globalCollections = await import("./opsGlobalCollections.ts").catch(
  () => ({}),
);

test("Home requests only globally complete non-checklist Task 3 collections", () => {
  assert.equal(typeof globalCollections.opsHomeCollectionRequests, "function");
  assert.deepEqual(
    globalCollections.opsHomeCollectionRequests().map(({ module }) => module),
    [
      "work_items",
      "sessions",
      "decisions",
      "approval_index",
      "evidence",
      "audit",
    ],
  );
});

test("Work checklist request is exact selected-work canonical scope", () => {
  assert.equal(
    typeof globalCollections.opsChecklistCollectionRequest,
    "function",
  );
  assert.deepEqual(globalCollections.opsChecklistCollectionRequest("work:a"), {
    module: "checklist_items",
    scope: { work_item: "work:a", sort: "order_asc_then_id" },
  });
});

test("search identity uses capability revision and exact scope without snapshot churn", () => {
  assert.equal(typeof globalCollections.opsCollectionQueryKey, "function");
  const scope = {
    q: "  Exact  ",
    kind: "evidence",
    work: "work:a",
    sort: "rank_desc_then_observed_at_desc",
  };
  const first = globalCollections.opsCollectionQueryKey(
    { module: "search", scope },
    7,
    101,
  );
  assert.deepEqual(first, ["ops", "complete", "search", 7, scope]);
  assert.deepEqual(
    first,
    globalCollections.opsCollectionQueryKey(
      { module: "search", scope },
      7,
      102,
    ),
  );
  assert.notDeepEqual(
    first,
    globalCollections.opsCollectionQueryKey(
      { module: "search", scope: { ...scope, q: "Exact" } },
      7,
      101,
    ),
  );
});

test("first global load never mounts fabricated empty collections", () => {
  assert.equal(typeof globalCollections.opsGlobalBoundaryMode, "function");
  assert.equal(
    globalCollections.opsGlobalBoundaryMode("ready", true, {}),
    "loading",
  );
  assert.equal(
    globalCollections.opsGlobalBoundaryMode("ready", true, {
      work_items: {
        status: "ready",
        items: [],
        revision: 1,
        refreshed: false,
      },
    }),
    "content",
  );
});

test("unrequested modules stay omitted even when capability revision is absent", () => {
  assert.equal(
    typeof globalCollections.opsCollectionLifecycleState,
    "function",
  );
  assert.deepEqual(
    globalCollections.opsCollectionLifecycleState(null, false, undefined),
    { status: "not_requested" },
  );
  assert.deepEqual(
    globalCollections.opsCollectionLifecycleState(null, true, undefined),
    { status: "unavailable" },
  );
});

test("a requested page transport failure stays module-local", () => {
  assert.deepEqual(
    globalCollections.opsCollectionLifecycleState(
      4,
      true,
      undefined,
      new Error("transport disconnected"),
    ),
    { status: "disconnected" },
  );
});
