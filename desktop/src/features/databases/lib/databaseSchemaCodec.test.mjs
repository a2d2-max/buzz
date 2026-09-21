import assert from "node:assert/strict";
import test from "node:test";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const AUTHOR = "a".repeat(64);

function schemaContent(overrides = {}) {
  return {
    name: "Product work",
    icon: "📊",
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "integer" },
      },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: {
          choices: [{ id: "todo", name: "To do", color: "blue" }],
        },
      },
      {
        id: "depends",
        name: "Depends on",
        type: "relation",
        options: {
          databaseId: DATABASE_ID,
          direction: "authoritative",
          mirroredPropertyId: "blocks",
        },
      },
      {
        id: "score",
        name: "Score",
        type: "formula",
        options: { expression: 'prop("Effort") * 2' },
      },
      {
        id: "sum",
        name: "Sum",
        type: "rollup",
        options: {
          relationPropertyId: "depends",
          targetPropertyId: "effort",
          calculation: "sum",
        },
      },
      {
        id: "phase",
        name: "Phase",
        type: "status",
        options: {
          choices: [{ id: "queued", name: "Queued", group: "todo" }],
        },
      },
    ],
    views: [
      {
        id: "table",
        name: "All work",
        type: "table",
        filter: {
          kind: "group",
          operator: "and",
          filters: [
            {
              kind: "rule",
              propertyId: "status",
              operator: "equals",
              value: "todo",
            },
          ],
        },
        sorts: [{ propertyId: "effort", direction: "descending" }],
        group: { propertyId: "status", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "effort"],
        propertyWidths: { title: 320, status: 180 },
      },
    ],
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
    kind: 30624,
    tags: [
      ["d", codec.databaseSchemaDTag(DATABASE_ID)],
      ["t", "community-db"],
    ],
    content: codec.serializeDatabaseSchemaContent(schemaContent()),
    sig: "f".repeat(128),
    ...overrides,
  };
}

test("schema event round-trips every property option and saved view field", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const parsed = codec.parseDatabaseSchemaEvent(event(codec));
  assert.ok(parsed);
  assert.equal(parsed.id, DATABASE_ID);
  assert.equal(parsed.author, AUTHOR);
  assert.equal(parsed.eventKind, 30624);
  assert.equal(parsed.deleted, false);
  assert.deepEqual(
    {
      name: parsed.name,
      icon: parsed.icon,
      properties: parsed.properties,
      views: parsed.views,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    },
    schemaContent(),
  );

  const input = codec.buildDatabaseSchemaEventInput({
    id: DATABASE_ID,
    ...schemaContent(),
  });
  assert.equal(input.kind, 30624);
  assert.deepEqual(input.tags, [
    ["d", `db:${DATABASE_ID}`],
    ["t", "community-db"],
  ]);
  assert.equal(
    codec.buildDatabaseSchemaEventInput(
      { id: DATABASE_ID, ...schemaContent() },
      30078,
    ).kind,
    30078,
    "the same codec builds the legacy fallback event",
  );
});

test("schema builder rejects kinds and coordinates its parser cannot read", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const schema = { id: DATABASE_ID, ...schemaContent() };

  assert.throws(
    () => codec.buildDatabaseSchemaEventInput(schema, 30625),
    /schema event kind/i,
  );
  assert.throws(
    () =>
      codec.buildDatabaseSchemaEventInput({
        ...schema,
        id: "not-a-database-uuid",
      }),
    /database id/i,
  );
  assert.throws(
    () =>
      codec.buildDatabaseSchemaEventInput({
        ...schema,
        properties: [
          { id: "title", name: "Name", type: "title" },
          {
            id: "effort",
            name: "Effort",
            type: "number",
            options: { format: "integer", unexpected: true },
          },
        ],
        views: [],
      }),
    /schema content/i,
  );
});

test("schema codec preserves every supported property type", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const simpleTypes = [
    "text",
    "date",
    "checkbox",
    "url",
    "email",
    "phone",
    "person",
    "created_time",
    "last_edited_time",
    "created_by",
    "last_edited_by",
    "files",
  ];
  const properties = [
    { id: "title", name: "Name", type: "title" },
    ...simpleTypes.map((type) => ({ id: type, name: type, type })),
    {
      id: "number",
      name: "Number",
      type: "number",
      options: { format: "percent" },
    },
    {
      id: "select",
      name: "Select",
      type: "select",
      options: { choices: [] },
    },
    {
      id: "multi_select",
      name: "Multi",
      type: "multi_select",
      options: { choices: [] },
    },
    {
      id: "relation",
      name: "Relation",
      type: "relation",
      options: { databaseId: DATABASE_ID, direction: "authoritative" },
    },
    {
      id: "formula",
      name: "Formula",
      type: "formula",
      options: { expression: "1 + 1" },
    },
    {
      id: "rollup",
      name: "Rollup",
      type: "rollup",
      options: {
        relationPropertyId: "relation",
        targetPropertyId: "number",
        calculation: "avg",
      },
    },
    {
      id: "status",
      name: "Status",
      type: "status",
      options: { choices: [] },
    },
  ];
  const parsed = codec.parseDatabaseSchemaContent(
    schemaContent({ properties, views: [] }),
  );
  assert.deepEqual(
    parsed?.properties.map((property) => property.type).sort(),
    [...codec.DATABASE_PROPERTY_TYPES].sort(),
  );
});

test("schema codec round-trips bounded prior property definitions strictly", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const content = schemaContent({
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "priority",
        name: "Priority",
        type: "text",
        priorDefinitions: [
          {
            type: "select",
            options: {
              choices: [{ id: "ready", name: "Ready", color: "green" }],
            },
          },
          { type: "number", options: { format: "won" } },
        ],
      },
    ],
    views: [],
  });
  assert.deepEqual(codec.parseDatabaseSchemaContent(content), content);
  assert.deepEqual(
    JSON.parse(codec.serializeDatabaseSchemaContent(content)),
    content,
  );

  for (const priorDefinitions of [
    [
      { type: "select", options: { choices: [] } },
      { type: "select", options: { choices: [] } },
    ],
    [{ type: "number", options: { format: "compact" } }],
    [{ type: "text", unexpected: true }],
  ]) {
    assert.equal(
      codec.parseDatabaseSchemaContent(
        schemaContent({
          properties: [
            { id: "title", name: "Name", type: "title" },
            {
              id: "priority",
              name: "Priority",
              type: "text",
              priorDefinitions,
            },
          ],
          views: [],
        }),
      ),
      null,
    );
  }
});

test("schema codec round-trips declared computed result types and rejects unknown ones", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const content = schemaContent({
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "formula",
        name: "Formula",
        type: "formula",
        options: { expression: "true", resultType: "boolean" },
      },
      {
        id: "rollup",
        name: "Rollup",
        type: "rollup",
        options: {
          relationPropertyId: "relation",
          targetPropertyId: "date",
          calculation: "show",
          resultType: "date_list",
        },
      },
    ],
    views: [],
  });
  assert.deepEqual(codec.parseDatabaseSchemaContent(content), content);
  const malformed = structuredClone(content);
  malformed.properties[1].options.resultType = "object";
  assert.equal(codec.parseDatabaseSchemaContent(malformed), null);
});

test("schema codec accepts tagged legacy events and rejects foreign or ambiguous coordinates", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const legacy = codec.parseDatabaseSchemaEvent(event(codec, { kind: 30078 }));
  assert.equal(legacy?.eventKind, 30078);
  assert.deepEqual(codec.COMMUNITY_DATABASE_SCHEMA_QUERY_KINDS, [30624, 30078]);
  assert.equal(
    codec.parseDatabaseSchemaEvent(event(codec, { kind: 30625 })),
    null,
  );
  assert.equal(
    codec.parseDatabaseSchemaEvent(
      event(codec, { tags: [["d", `db:${DATABASE_ID}`]] }),
    ),
    null,
  );
  assert.equal(
    codec.parseDatabaseSchemaEvent(
      event(codec, {
        tags: [
          ["d", `db:${DATABASE_ID}`],
          ["d", "db:22222222-2222-4222-8222-222222222222"],
          ["t", "community-db"],
        ],
      }),
    ),
    null,
  );
  assert.equal(codec.databaseSchemaIdFromDTag("db:../other"), null);
});

test("schema validation enforces one title and strict local view references", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  assert.equal(
    codec.parseDatabaseSchemaContent(schemaContent({ properties: [] })),
    null,
    "a database needs exactly one title property",
  );
  assert.equal(
    codec.parseDatabaseSchemaContent(
      schemaContent({
        properties: [
          { id: "title-a", name: "A", type: "title" },
          { id: "title-b", name: "B", type: "title" },
        ],
      }),
    ),
    null,
    "two title properties are invalid",
  );
  assert.equal(
    codec.parseDatabaseSchemaContent(
      schemaContent({
        views: [
          {
            id: "bad",
            name: "Bad",
            type: "table",
            sorts: [{ propertyId: "missing", direction: "ascending" }],
            visiblePropertyIds: ["title"],
          },
        ],
      }),
    ),
    null,
    "view fields cannot point at a missing local property",
  );
});

test("relation owner defaults for legacy payloads while semantic computed references stay repairable", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const legacy = schemaContent({
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "relation",
        name: "Legacy relation",
        type: "relation",
        options: { databaseId: DATABASE_ID },
      },
      {
        id: "sum",
        name: "Sum",
        type: "rollup",
        options: {
          relationPropertyId: "missing",
          targetPropertyId: "amount",
          calculation: "sum",
        },
      },
    ],
    views: [],
  });
  const parsed = codec.parseDatabaseSchemaContent(legacy);
  assert.equal(parsed?.properties[1].options.direction, "authoritative");
  assert.equal(parsed?.properties[2].options.relationPropertyId, "missing");
  assert.equal(
    codec.parseDatabaseSchemaContent({
      ...legacy,
      properties: legacy.properties.map((property) =>
        property.id === "relation"
          ? { ...property, options: { ...property.options, direction: "both" } }
          : property,
      ),
    }),
    null,
  );
});

test("dangling filter and group property ids survive strict parsing for view repair", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const content = schemaContent({
    views: [
      {
        id: "repair",
        name: "Repair",
        type: "table",
        filter: {
          kind: "rule",
          propertyId: "removed-filter",
          operator: "equals",
          value: "old",
        },
        sorts: [],
        group: {
          propertyId: "removed-group",
          direction: "ascending",
        },
        visiblePropertyIds: ["title"],
      },
    ],
  });
  assert.deepEqual(codec.parseDatabaseSchemaContent(content), content);
  for (const broken of [
    {
      ...content,
      views: [
        {
          ...content.views[0],
          filter: {
            kind: "rule",
            propertyId: "../removed",
            operator: "equals",
            value: "old",
          },
        },
      ],
    },
    {
      ...content,
      views: [
        {
          ...content.views[0],
          group: { propertyId: "../removed", direction: "ascending" },
        },
      ],
    },
  ]) {
    assert.equal(codec.parseDatabaseSchemaContent(broken), null);
  }
});

test("schema event parser rejects malformed declared fields instead of normalizing them", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const malformed = [
    schemaContent({ deleted: "true" }),
    schemaContent({
      properties: [
        { id: "title", name: "Name", type: "title" },
        {
          id: "effort",
          name: "Effort",
          type: "number",
          options: { format: "integer", unexpected: true },
        },
      ],
      views: [],
    }),
    schemaContent({
      properties: [
        {
          id: "title",
          name: "Name",
          type: "title",
          options: { unexpected: true },
        },
      ],
      views: [],
    }),
  ];

  for (const content of malformed) {
    assert.equal(
      codec.parseDatabaseSchemaEvent(
        event(codec, { content: JSON.stringify(content) }),
      ),
      null,
    );
  }

  const explicitLive = codec.parseDatabaseSchemaEvent(
    event(codec, {
      content: JSON.stringify(schemaContent({ deleted: false })),
    }),
  );
  assert.equal(explicitLive?.deleted, false);
});

test("schema LWW resolves across authors by relay time then event id", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const older = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Older" }),
      ),
    }),
  );
  const newer = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 101,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Newer" }),
      ),
    }),
  );
  assert.ok(older && newer);
  assert.equal(
    codec.pickLatestDatabaseSchemas([newer, older]).get(DATABASE_ID)?.name,
    "Newer",
  );
});

test("schema LWW uses the larger event id for equal relay seconds in either input order", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const lower = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Lower id" }),
      ),
    }),
  );
  const higher = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Higher id" }),
      ),
    }),
  );
  assert.ok(lower && higher);
  for (const versions of [
    [lower, higher],
    [higher, lower],
  ]) {
    assert.equal(
      codec.pickLatestDatabaseSchemas(versions).get(DATABASE_ID)?.name,
      "Higher id",
    );
  }
});

test("schema LWW applies a mixed-kind tombstone and a later live resurrection", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const original = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "a".repeat(64),
      created_at: 100,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Original" }),
      ),
    }),
  );
  const tombstone = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "b".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 101,
      kind: 30078,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Deleted", deleted: true }),
      ),
    }),
  );
  const resurrection = codec.parseDatabaseSchemaEvent(
    event(codec, {
      id: "c".repeat(64),
      pubkey: "c".repeat(64),
      created_at: 102,
      content: codec.serializeDatabaseSchemaContent(
        schemaContent({ name: "Restored" }),
      ),
    }),
  );
  assert.ok(original && tombstone && resurrection);
  const deleted = codec
    .pickLatestDatabaseSchemas([tombstone, original])
    .get(DATABASE_ID);
  assert.equal(deleted?.deleted, true);
  assert.equal(deleted?.eventKind, 30078);
  const restored = codec
    .pickLatestDatabaseSchemas([resurrection, original, tombstone])
    .get(DATABASE_ID);
  assert.equal(restored?.deleted, false);
  assert.equal(restored?.name, "Restored");
  assert.equal(restored?.eventKind, 30624);
});

test("schema size measurement counts serialized UTF-8 bytes", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const ascii = codec.measureDatabaseSchemaContentBytes({
    id: DATABASE_ID,
    ...schemaContent({ name: "aaaa" }),
  });
  const hangul = codec.measureDatabaseSchemaContentBytes({
    id: DATABASE_ID,
    ...schemaContent({ name: "가나다라" }),
  });
  assert.equal(hangul - ascii, 8);
  assert.equal(codec.DATABASE_MAX_CONTENT_BYTES, 256 * 1024);
});
