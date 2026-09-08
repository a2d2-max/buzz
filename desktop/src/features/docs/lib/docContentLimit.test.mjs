import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  DOC_CONTENT_LIMIT_RECHECK_MS,
  DOC_DEFAULT_MAX_CONTENT_BYTES,
  resolveCurrentRelayMaxContentBytes,
  resolveMaxContentBytes,
  resolveRelayMaxContentBytes,
} from "./docContentLimit.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const RELAY_A = "wss://a.example";
const RELAY_B = "wss://b.example";
const RELAY_INFO_MAX_BYTES = 64 * 1024;
const originalFetch = globalThis.fetch;

before(() => {
  Object.assign(globalThis, { window: dom.window });
});

afterEach(() => {
  dom.window.localStorage.clear();
  globalThis.fetch = originalFetch;
});

after(() => dom.window.close());

test("resolveMaxContentBytes uses the positive safe integer from NIP-11", () => {
  assert.equal(
    resolveMaxContentBytes({ limitation: { max_content_length: 1_048_576 } }),
    1_048_576,
  );
});

test("resolveMaxContentBytes falls back for missing and malformed values", () => {
  for (const relayInfo of [
    null,
    {},
    { limitation: null },
    { limitation: {} },
    { limitation: { max_content_length: "1048576" } },
    { limitation: { max_content_length: 0 } },
    { limitation: { max_content_length: -1 } },
    { limitation: { max_content_length: 1.5 } },
    { limitation: { max_content_length: Number.POSITIVE_INFINITY } },
    { limitation: { max_content_length: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    assert.equal(
      resolveMaxContentBytes(relayInfo),
      DOC_DEFAULT_MAX_CONTENT_BYTES,
    );
  }
});

test("relay limits are cached per URL until the doc-kind recheck interval", async () => {
  let calls = 0;
  const fetchInfo = async (relayUrl) => {
    calls += 1;
    return {
      limitation: {
        max_content_length: relayUrl === RELAY_A ? 1_048_576 : 2_097_152,
      },
    };
  };
  const now = 10_000;

  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_A, now, fetchInfo),
    1_048_576,
  );
  assert.equal(
    await resolveRelayMaxContentBytes(
      RELAY_A,
      now + DOC_CONTENT_LIMIT_RECHECK_MS - 1,
      fetchInfo,
    ),
    1_048_576,
  );
  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_B, now, fetchInfo),
    2_097_152,
  );
  assert.equal(
    calls,
    2,
    "A cache hit must not mask B's independent relay value",
  );

  assert.equal(
    await resolveRelayMaxContentBytes(
      RELAY_A,
      now + DOC_CONTENT_LIMIT_RECHECK_MS,
      fetchInfo,
    ),
    1_048_576,
  );
  assert.equal(calls, 3, "the exact expiry boundary re-fetches NIP-11");
});

test("failed or malformed NIP-11 reads fall back without poisoning the cache", async () => {
  let calls = 0;
  const fetchInfo = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    if (calls === 2) return { limitation: { max_content_length: 0 } };
    return { limitation: { max_content_length: 1_048_576 } };
  };

  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_A, 1, fetchInfo),
    DOC_DEFAULT_MAX_CONTENT_BYTES,
  );
  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_A, 2, fetchInfo),
    DOC_DEFAULT_MAX_CONTENT_BYTES,
  );
  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_A, 3, fetchInfo),
    1_048_576,
  );
  assert.equal(calls, 3);
});

test("a fetch that never resolves reaches the fallback at the configured deadline", async () => {
  const outcome = await Promise.race([
    resolveRelayMaxContentBytes(
      RELAY_A,
      1,
      async () => new Promise(() => {}),
      10,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  assert.equal(outcome, DOC_DEFAULT_MAX_CONTENT_BYTES);
});

test("a stalled response body reaches the fallback and aborts the request", async () => {
  let requestSignal;
  globalThis.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({ read: async () => new Promise(() => {}) }),
      },
      json: async () => new Promise(() => {}),
    };
  };

  const outcome = await Promise.race([
    resolveRelayMaxContentBytes(RELAY_A, 1, undefined, 10),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 100)),
  ]);
  assert.equal(outcome, DOC_DEFAULT_MAX_CONTENT_BYTES);
  assert.equal(requestSignal?.aborted, true);
});

test("declared and streamed oversized NIP-11 bodies are cancelled", async () => {
  let declaredCancelled = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      "Content-Length": String(RELAY_INFO_MAX_BYTES + 1),
    }),
    body: {
      cancel: async () => {
        declaredCancelled = true;
      },
      getReader: () => {
        throw new Error("a declared oversized body must not be read");
      },
    },
  });
  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_A, 1),
    DOC_DEFAULT_MAX_CONTENT_BYTES,
  );
  assert.equal(declaredCancelled, true);

  let streamedCancelled = false;
  let reads = 0;
  const chunks = [
    new Uint8Array(RELAY_INFO_MAX_BYTES),
    new Uint8Array(1),
    new Uint8Array(1),
  ];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => ({
        cancel: async () => {
          streamedCancelled = true;
        },
        read: async () => {
          const value = chunks[reads];
          reads += 1;
          return value ? { done: false, value } : { done: true };
        },
      }),
    },
  });
  assert.equal(
    await resolveRelayMaxContentBytes(RELAY_B, 1),
    DOC_DEFAULT_MAX_CONTENT_BYTES,
  );
  assert.equal(streamedCancelled, true);
  assert.equal(reads, 2, "the reader stops at the first over-cap chunk");
});

test("a valid NIP-11 body immediately below the cap resolves and caches", async () => {
  const prefix = '{"limitation":{"max_content_length":524288},"padding":"';
  const suffix = '"}';
  const payload = `${prefix}${"x".repeat(
    RELAY_INFO_MAX_BYTES - 1 - prefix.length - suffix.length,
  )}${suffix}`;
  assert.equal(
    new TextEncoder().encode(payload).length,
    RELAY_INFO_MAX_BYTES - 1,
  );
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(payload, {
      headers: { "Content-Length": String(RELAY_INFO_MAX_BYTES - 1) },
    });
  };

  assert.equal(await resolveRelayMaxContentBytes(RELAY_A, 1), 524_288);
  assert.equal(await resolveRelayMaxContentBytes(RELAY_A, 2), 524_288);
  assert.equal(calls, 1);
});

test("a delayed old-community response aborts instead of authorizing a write on the new relay", async () => {
  const relayReads = [RELAY_A, RELAY_B];
  const getCurrentRelayUrl = async () => relayReads.shift() ?? RELAY_B;
  const fetched = [];
  const fetchInfo = async (relayUrl) => {
    fetched.push(relayUrl);
    return {
      limitation: {
        max_content_length: relayUrl === RELAY_A ? 2_097_152 : 1_048_576,
      },
    };
  };

  await assert.rejects(
    resolveCurrentRelayMaxContentBytes(getCurrentRelayUrl, 1_000, fetchInfo),
    /active community changed/,
  );
  assert.deepEqual(fetched, [RELAY_A]);
});
