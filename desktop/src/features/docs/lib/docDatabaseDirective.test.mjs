import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDocDatabaseDirectiveLine,
  preservesDocDatabaseDirectives,
  serializeDocDatabaseDirective,
} from "./docDatabaseDirective.ts";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";

test("database directives accept only one standalone column-zero line", () => {
  assert.deepEqual(parseDocDatabaseDirectiveLine(`:::db ${DATABASE_ID}`), {
    databaseId: DATABASE_ID,
    viewId: null,
  });
  assert.deepEqual(
    parseDocDatabaseDirectiveLine(`:::db ${DATABASE_ID} board_view`),
    { databaseId: DATABASE_ID, viewId: "board_view" },
  );
  for (const source of [
    ` :::db ${DATABASE_ID}`,
    `\t:::db ${DATABASE_ID}`,
    `\\:::db ${DATABASE_ID}`,
    `text :::db ${DATABASE_ID}`,
    `:::db  ${DATABASE_ID}`,
    `:::db ${DATABASE_ID} board extra`,
    ":::db not-a-uuid",
    `:::db ${DATABASE_ID} ../board`,
    `:::db ${DATABASE_ID}\n`,
  ]) {
    assert.equal(parseDocDatabaseDirectiveLine(source), null, source);
  }
});

test("database directives serialize one canonical line while preserving valid missing ids", () => {
  assert.equal(
    serializeDocDatabaseDirective({ databaseId: DATABASE_ID, viewId: null }),
    `:::db ${DATABASE_ID}`,
  );
  assert.equal(
    serializeDocDatabaseDirective({
      databaseId: DATABASE_ID,
      viewId: "missing_view",
    }),
    `:::db ${DATABASE_ID} missing_view`,
  );
});

test("conversion preserves repeated references and their selected views", () => {
  const line = `:::db ${DATABASE_ID} board`;
  assert.equal(preservesDocDatabaseDirectives(`${line}\n${line}`, line), false);
  assert.equal(
    preservesDocDatabaseDirectives(line, `:::db ${DATABASE_ID} table`),
    false,
  );
  assert.equal(
    preservesDocDatabaseDirectives(
      `${line}\n${line}`,
      `${line}\ntext\n${line}`,
    ),
    true,
  );
});
