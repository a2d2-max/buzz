import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  DEDICATED_KIND_RECHECK_MS,
  dedicatedDocKindMarkedUnsupported,
  isUnknownKindRejection,
  markDedicatedDocKindAccepted,
  markDedicatedDocKindRejected,
} from "./docKindSupport.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const RELAY = "wss://a2d2.communities.example/relay";

before(() => {
  Object.assign(globalThis, { window: dom.window });
});

afterEach(() => {
  dom.window.localStorage.clear();
});

after(() => dom.window.close());

// ── isUnknownKindRejection ───────────────────────────────────────────────────

test("isUnknownKindRejection: matches the relay's unknown-kind OK-false verbatim", () => {
  assert.equal(
    isUnknownKindRejection(new Error("restricted: unknown event kind")),
    true,
  );
  // Loose on wording drift, still anchored on "unknown … kind".
  assert.equal(isUnknownKindRejection(new Error("Unknown kind")), true);
});

test("isUnknownKindRejection: any other failure must not flip the relay to legacy", () => {
  assert.equal(
    isUnknownKindRejection(
      new Error("restricted: community writes are fenced"),
    ),
    false,
  );
  assert.equal(
    isUnknownKindRejection(new Error("rate-limited: slow down")),
    false,
  );
  assert.equal(
    isUnknownKindRejection(new Error("Timed out publishing the page.")),
    false,
  );
  assert.equal(isUnknownKindRejection("unknown event kind"), false);
  assert.equal(isUnknownKindRejection(undefined), false);
});

// ── verdict lifecycle ────────────────────────────────────────────────────────

test("an unmarked relay is treated as supporting the dedicated kind", () => {
  assert.equal(dedicatedDocKindMarkedUnsupported(RELAY, 1_000), false);
});

test("a rejected verdict holds until the recheck interval, then expires", () => {
  const now = 1_000_000;
  markDedicatedDocKindRejected(RELAY, now);
  assert.equal(dedicatedDocKindMarkedUnsupported(RELAY, now), true);
  assert.equal(
    dedicatedDocKindMarkedUnsupported(
      RELAY,
      now + DEDICATED_KIND_RECHECK_MS - 1,
    ),
    true,
  );
  // Expired: the next write re-probes 30623 against a possibly-upgraded relay.
  assert.equal(
    dedicatedDocKindMarkedUnsupported(RELAY, now + DEDICATED_KIND_RECHECK_MS),
    false,
  );
});

test("the verdict is per relay URL and survives via localStorage", () => {
  const now = 5_000;
  markDedicatedDocKindRejected(RELAY, now);
  assert.equal(
    dedicatedDocKindMarkedUnsupported("wss://other.example", now),
    false,
    "another relay is unaffected",
  );
  assert.ok(
    dom.window.localStorage.getItem(`docs:dedicated-kind-rejected:${RELAY}`),
    "persisted, so it survives an app restart",
  );
});

test("an accepted publish clears the verdict", () => {
  const now = 5_000;
  markDedicatedDocKindRejected(RELAY, now);
  markDedicatedDocKindAccepted(RELAY);
  assert.equal(dedicatedDocKindMarkedUnsupported(RELAY, now), false);
});

test("a garbage stored value reads as unmarked", () => {
  dom.window.localStorage.setItem(
    `docs:dedicated-kind-rejected:${RELAY}`,
    "not-a-number",
  );
  assert.equal(dedicatedDocKindMarkedUnsupported(RELAY, 1_000), false);
});

test("unavailable storage never throws — every call degrades to unmarked", () => {
  const original = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
  Object.defineProperty(dom.window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assert.equal(dedicatedDocKindMarkedUnsupported(RELAY, 1_000), false);
    markDedicatedDocKindRejected(RELAY, 1_000);
    markDedicatedDocKindAccepted(RELAY);
  } finally {
    Object.defineProperty(dom.window, "localStorage", original);
  }
});
