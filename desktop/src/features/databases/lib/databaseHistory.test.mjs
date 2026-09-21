import assert from "node:assert/strict";
import test from "node:test";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";

function relayEvent({ id, kind = 30078, createdAt, tags = [] }) {
  return {
    id: id.repeat(64),
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind,
    tags,
    content: "{}",
    sig: "f".repeat(128),
  };
}

test("schema history uses a kinds-only composite cursor and finds tagged data behind noise", async () => {
  const { fetchDatabaseSchemasToExhaustion } = await import(
    "./databaseHistory.ts"
  );
  const filters = [];
  const batches = [
    [
      relayEvent({ id: "a", createdAt: 100 }),
      relayEvent({ id: "b", createdAt: 100 }),
    ],
    [
      relayEvent({ id: "c", createdAt: 100 }),
      relayEvent({ id: "d", createdAt: 99 }),
    ],
    [
      {
        ...relayEvent({
          id: "e",
          kind: 30624,
          createdAt: 98,
          tags: [
            ["d", `db:${DATABASE_ID}`],
            ["t", "community-db"],
          ],
        }),
        content: JSON.stringify({
          name: "Found",
          properties: [{ id: "title", name: "Name", type: "title" }],
          views: [],
          createdAt: 1,
          updatedAt: 1,
        }),
      },
    ],
  ];
  const result = await fetchDatabaseSchemasToExhaustion({
    pageLimit: 2,
    fetchEvents: async (filter) => {
      filters.push(filter);
      return batches.shift() ?? [];
    },
  });

  assert.equal(result.schemas[0]?.name, "Found");
  assert.equal(result.scanned, 5);
  assert.equal(result.truncated, false);
  assert.deepEqual(filters[0], { kinds: [30624, 30078], limit: 2 });
  assert.deepEqual(filters[1], {
    kinds: [30624, 30078],
    limit: 2,
    until: 100,
    before_id: "b".repeat(64),
  });
  assert.equal("#t" in filters[0], false);
  assert.equal("#db" in filters[0], false);
});

test("row history reports truncation at its hard page bound", async () => {
  const { fetchDatabaseRowsToExhaustion } = await import(
    "./databaseHistory.ts"
  );
  const result = await fetchDatabaseRowsToExhaustion({
    maxPages: 1,
    pageLimit: 2,
    fetchEvents: async () => [
      relayEvent({ id: "a", kind: 30625, createdAt: 10 }),
      relayEvent({ id: "b", kind: 30625, createdAt: 9 }),
    ],
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.newestSeen, 10);
});
