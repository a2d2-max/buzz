import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const RELAY = "wss://community.example";

before(() => Object.assign(globalThis, { window: dom.window }));
afterEach(() => dom.window.localStorage.clear());
after(() => dom.window.close());

test("schema and row support verdicts are independent on the same relay", async () => {
  const support = await import("./databaseKindSupport.ts");
  support.markDatabaseSchemaKindRejected(RELAY, 1_000);
  assert.equal(support.databaseSchemaKindMarkedUnsupported(RELAY, 1_000), true);
  assert.equal(support.databaseRowKindMarkedUnsupported(RELAY, 1_000), false);

  support.markDatabaseRowKindRejected(RELAY, 1_000);
  support.markDatabaseSchemaKindAccepted(RELAY);
  assert.equal(
    support.databaseSchemaKindMarkedUnsupported(RELAY, 1_000),
    false,
  );
  assert.equal(support.databaseRowKindMarkedUnsupported(RELAY, 1_000), true);
});
