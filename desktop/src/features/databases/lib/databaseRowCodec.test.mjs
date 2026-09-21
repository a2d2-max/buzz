import assert from "node:assert/strict";
import test from "node:test";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_DATABASE_ID = "99999999-2222-4333-8444-555555555555";
const ROW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ROW_ID = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AUTHOR = "a".repeat(64);

function rowContent(overrides = {}) {
  return {
    values: {
      title: "Ship databases",
      effort: 3,
      done: false,
      labels: ["ux", "desktop"],
      due: {
        start: "2026-09-08",
        end: "2026-09-10",
        includeTime: false,
      },
      files: [{ url: "https://example.com/spec.pdf", name: "Spec" }],
      empty: null,
    },
    docPageId: null,
    createdBy: AUTHOR,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

function event(codec, overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_700_000_100,
    kind: 30625,
    tags: [
      ["d", codec.databaseRowDTag(ROW_ID)],
      ["t", "community-db-row"],
      ["db", DATABASE_ID],
    ],
    content: codec.serializeDatabaseRowContent(rowContent()),
    sig: "f".repeat(128),
    ...overrides,
  };
}

test("row event round-trips typed cell values and its database coordinate", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const parsed = codec.parseDatabaseRowEvent(event(codec));
  assert.ok(parsed);
  assert.equal(parsed.id, ROW_ID);
  assert.equal(parsed.databaseId, DATABASE_ID);
  assert.equal(parsed.author, AUTHOR);
  assert.equal(parsed.eventKind, 30625);
  assert.equal(parsed.deleted, false);
  assert.deepEqual(
    {
      values: parsed.values,
      docPageId: parsed.docPageId,
      createdBy: parsed.createdBy,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    },
    rowContent(),
  );

  const input = codec.buildDatabaseRowEventInput({
    id: ROW_ID,
    databaseId: DATABASE_ID,
    ...rowContent(),
  });
  assert.equal(input.kind, 30625);
  assert.deepEqual(input.tags, [
    ["d", `dbrow:${ROW_ID}`],
    ["t", "community-db-row"],
    ["db", DATABASE_ID],
  ]);
  assert.equal(
    codec.buildDatabaseRowEventInput(
      { id: ROW_ID, databaseId: DATABASE_ID, ...rowContent() },
      30078,
    ).kind,
    30078,
    "the same codec builds the legacy fallback event",
  );
});

test("row creator is stable metadata while the event author is the latest editor", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const edited = codec.parseDatabaseRowEvent(
    event(codec, {
      pubkey: "b".repeat(64),
      content: codec.serializeDatabaseRowContent(
        rowContent({ createdBy: AUTHOR }),
      ),
    }),
  );
  assert.equal(edited?.createdBy, AUTHOR);
  assert.equal(edited?.author, "b".repeat(64));

  const legacyContent = rowContent();
  delete legacyContent.createdBy;
  const legacy = codec.parseDatabaseRowEvent(
    event(codec, { content: JSON.stringify(legacyContent) }),
  );
  assert.equal(legacy?.createdBy, null);
  assert.equal(
    codec.parseDatabaseRowEvent(
      event(codec, {
        content: JSON.stringify(rowContent({ createdBy: "not-a-pubkey" })),
      }),
    ),
    null,
  );
});

test("row builder rejects kinds and coordinates its parser cannot read", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const row = {
    id: ROW_ID,
    databaseId: DATABASE_ID,
    ...rowContent(),
  };

  assert.throws(
    () => codec.buildDatabaseRowEventInput(row, 30624),
    /row event kind/i,
  );
  assert.throws(
    () => codec.buildDatabaseRowEventInput({ ...row, id: "not-a-row-uuid" }),
    /row id/i,
  );
  assert.throws(
    () =>
      codec.buildDatabaseRowEventInput({
        ...row,
        databaseId: "not-a-database-uuid",
      }),
    /database id/i,
  );
  assert.throws(
    () =>
      codec.buildDatabaseRowEventInput({
        ...row,
        deleted: "true",
      }),
    /row content/i,
  );
});

test("row codec accepts tagged legacy events and rejects malformed coordinates or values", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const legacy = codec.parseDatabaseRowEvent(event(codec, { kind: 30078 }));
  assert.equal(legacy?.eventKind, 30078);
  assert.deepEqual(codec.COMMUNITY_DATABASE_ROW_QUERY_KINDS, [30625, 30078]);

  assert.equal(
    codec.parseDatabaseRowEvent(
      event(codec, {
        tags: [
          ["d", `dbrow:${ROW_ID}`],
          ["t", "community-db-row"],
        ],
      }),
    ),
    null,
    "the db tag is required",
  );
  assert.equal(
    codec.parseDatabaseRowEvent(
      event(codec, {
        content: JSON.stringify(
          rowContent({ values: { bad: { arbitrary: "object" } } }),
        ),
      }),
    ),
    null,
    "unknown object-shaped cell values do not enter the store",
  );
  assert.equal(codec.databaseRowIdFromDTag("dbrow:../other"), null);
});

test("row event parser rejects malformed declared fields instead of normalizing them", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const malformed = [
    rowContent({ deleted: "true" }),
    rowContent({
      values: {
        due: {
          start: "2026-09-08",
          includeTime: false,
          unexpected: true,
        },
      },
    }),
    rowContent({
      values: {
        files: [
          {
            url: "https://example.com/spec.pdf",
            name: "Spec",
            unexpected: true,
          },
        ],
      },
    }),
  ];

  for (const content of malformed) {
    assert.equal(
      codec.parseDatabaseRowEvent(
        event(codec, { content: JSON.stringify(content) }),
      ),
      null,
    );
  }

  const explicitLive = codec.parseDatabaseRowEvent(
    event(codec, { content: JSON.stringify(rowContent({ deleted: false })) }),
  );
  assert.equal(explicitLive?.deleted, false);
});

test("row LWW follows the dbrow d-tag while keeping other rows independent", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const older = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Older" } }),
      ),
    }),
  );
  const newer = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 101,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Newer" } }),
      ),
    }),
  );
  const otherRow = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "c".repeat(64),
      tags: [
        ["d", `dbrow:${OTHER_ROW_ID}`],
        ["t", "community-db-row"],
        ["db", DATABASE_ID],
      ],
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Other row" } }),
      ),
    }),
  );
  const sameRowIdOtherDatabase = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "d".repeat(64),
      created_at: 99,
      tags: [
        ["d", `dbrow:${ROW_ID}`],
        ["t", "community-db-row"],
        ["db", OTHER_DATABASE_ID],
      ],
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Other database" } }),
      ),
    }),
  );
  assert.ok(older && newer && otherRow && sameRowIdOtherDatabase);
  const latest = codec.pickLatestDatabaseRows([
    newer,
    otherRow,
    older,
    sameRowIdOtherDatabase,
  ]);
  assert.equal(latest.size, 2);
  assert.equal(latest.get(ROW_ID)?.values.title, "Newer");
  assert.equal(
    latest.get(ROW_ID)?.databaseId,
    DATABASE_ID,
    "db is row metadata, while the NIP-33 replacement coordinate is dbrow id",
  );
  assert.equal(latest.get(OTHER_ROW_ID)?.values.title, "Other row");
});

test("row LWW uses the larger event id for equal relay seconds in either input order", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const lower = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Lower id" } }),
      ),
    }),
  );
  const higher = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Higher id" } }),
      ),
    }),
  );
  assert.ok(lower && higher);
  for (const versions of [
    [lower, higher],
    [higher, lower],
  ]) {
    assert.equal(
      codec.pickLatestDatabaseRows(versions).get(ROW_ID)?.values.title,
      "Higher id",
    );
  }
});

test("row LWW applies a mixed-kind tombstone and a later live resurrection", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const original = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Original" } }),
      ),
    }),
  );
  const tombstone = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 101,
      kind: 30078,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Deleted" }, deleted: true }),
      ),
    }),
  );
  const resurrection = codec.parseDatabaseRowEvent(
    event(codec, {
      id: "c".repeat(64),
      pubkey: "c".repeat(64),
      created_at: 102,
      content: codec.serializeDatabaseRowContent(
        rowContent({ values: { title: "Restored" } }),
      ),
    }),
  );
  assert.ok(original && tombstone && resurrection);
  const deleted = codec
    .pickLatestDatabaseRows([original, tombstone])
    .get(ROW_ID);
  assert.equal(deleted?.deleted, true);
  assert.equal(deleted?.eventKind, 30078);
  const restored = codec
    .pickLatestDatabaseRows([tombstone, resurrection, original])
    .get(ROW_ID);
  assert.equal(restored?.deleted, false);
  assert.equal(restored?.values.title, "Restored");
  assert.equal(restored?.eventKind, 30625);
});

test("row size measurement counts serialized UTF-8 bytes", async () => {
  const codec = await import("./databaseRowCodec.ts");
  const ascii = codec.measureDatabaseRowContentBytes({
    id: ROW_ID,
    databaseId: DATABASE_ID,
    ...rowContent({ values: { title: "aaaa" } }),
  });
  const hangul = codec.measureDatabaseRowContentBytes({
    id: ROW_ID,
    databaseId: DATABASE_ID,
    ...rowContent({ values: { title: "가나다라" } }),
  });
  assert.equal(hangul - ascii, 8);
  assert.equal(codec.DATABASE_MAX_CONTENT_BYTES, 256 * 1024);
});
