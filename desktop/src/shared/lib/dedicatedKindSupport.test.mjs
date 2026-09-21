import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, { window: dom.window });
});

afterEach(() => {
  dom.window.localStorage.clear();
});

after(() => dom.window.close());

test("dedicated kind verdicts stay independent by feature and relay", async () => {
  const { createDedicatedKindSupport } = await import(
    "./dedicatedKindSupport.ts"
  );
  const schema = createDedicatedKindSupport(
    "databases:schema:dedicated-kind-rejected:",
  );
  const row = createDedicatedKindSupport(
    "databases:row:dedicated-kind-rejected:",
  );
  const relayA = "wss://a.example";
  const relayB = "wss://b.example";

  schema.markRejected(relayA, 1_000);

  assert.equal(schema.markedUnsupported(relayA, 1_000), true);
  assert.equal(row.markedUnsupported(relayA, 1_000), false);
  assert.equal(schema.markedUnsupported(relayB, 1_000), false);
  assert.equal(
    dom.window.localStorage.getItem(
      "databases:schema:dedicated-kind-rejected:wss://a.example",
    ),
    "1000",
  );
});

test("a support verdict expires after the shared 24-hour interval", async () => {
  const { DEDICATED_KIND_RECHECK_MS, createDedicatedKindSupport } =
    await import("./dedicatedKindSupport.ts");
  const support = createDedicatedKindSupport("feature:");
  support.markRejected("wss://relay.example", 10);
  assert.equal(
    support.markedUnsupported(
      "wss://relay.example",
      10 + DEDICATED_KIND_RECHECK_MS - 1,
    ),
    true,
  );
  assert.equal(
    support.markedUnsupported(
      "wss://relay.example",
      10 + DEDICATED_KIND_RECHECK_MS,
    ),
    false,
  );
});
