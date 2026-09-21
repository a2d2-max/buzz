import assert from "node:assert/strict";
import { test } from "node:test";
import * as fields from "./communityTaskCustomFields.ts";
const owner = "a".repeat(64);
const event = {
  id: "1".repeat(64),
  pubkey: owner,
  kind: 30078,
  created_at: 100,
  tags: [["d", "community-task-field:estimate"]],
  content: JSON.stringify({
    version: 1,
    name: "Estimate",
    type: "number",
    archived: false,
  }),
  sig: "s".repeat(128),
};
test("shared definitions derive identity from signer and address, never an owner claim in content", () => {
  assert.equal(typeof fields.parseCommunityTaskFieldDefinition, "function");
  const definition = fields.parseCommunityTaskFieldDefinition(event);
  assert.equal(definition.key, `${owner}:estimate`);
  assert.equal(definition.name, "Estimate");
  assert.equal(
    fields.parseCommunityTaskFieldDefinition({
      ...event,
      content: JSON.stringify({ version: 1, name: "Bad", type: "unknown" }),
    }),
    null,
  );
  assert.equal(
    fields.parseCommunityTaskFieldDefinition({
      ...event,
      tags: [...event.tags, ["d", "community-task-field:other"]],
    }),
    null,
  );
});
test("shared field rename updates display while archive and incompatible type preserve existing values", () => {
  assert.equal(typeof fields.applyCommunityTaskFieldDefinitions, "function");
  const key = `${owner}:estimate`;
  const values = [{ id: key, name: "Old name", type: "number", value: 2.5 }];
  const definition = {
    key,
    owner,
    id: "estimate",
    name: "Estimate",
    type: "number",
    archived: false,
    event,
  };
  assert.deepEqual(
    fields.applyCommunityTaskFieldDefinitions(values, [definition]),
    [{ ...values[0], name: "Estimate" }],
  );
  assert.deepEqual(
    fields.applyCommunityTaskFieldDefinitions(values, [
      { ...definition, archived: true },
    ]),
    values,
  );
  assert.deepEqual(
    fields.applyCommunityTaskFieldDefinitions(values, [
      { ...definition, type: "text" },
    ]),
    values,
  );
});
