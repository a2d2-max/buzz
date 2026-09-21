import assert from "node:assert/strict";
import test from "node:test";

test("the typed property registry covers every wire type and its editor seam", async () => {
  const codec = await import("./databaseSchemaCodec.ts");
  const registry = await import("./databasePropertyRegistry.ts");
  assert.deepEqual(
    Object.keys(registry.DATABASE_PROPERTY_REGISTRY).sort(),
    [...codec.DATABASE_PROPERTY_TYPES].sort(),
  );
  assert.equal(
    registry.databasePropertyRegistration("checkbox").editor,
    "checkbox",
  );
  assert.equal(
    registry.databasePropertyRegistration("select").editor,
    "select",
  );
  assert.equal(registry.databasePropertyRegistration("date").editor, "date");
  assert.equal(
    registry.databasePropertyRegistration("status").availableInTable,
    true,
  );
  assert.equal(
    registry.databasePropertyRegistration("formula").editor,
    "read_only",
  );
  assert.equal(
    registry.databasePropertyRegistration("rollup").editor,
    "read_only",
  );
  assert.equal(
    registry.databasePropertyRegistration("created_by").automatic,
    true,
  );
});
