import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";

import {
  fetchRelayContentLimit,
  parseRelayContentLimit,
} from "./relayContentLimit.ts";

const LEGACY_BYTES = 256 * 1024;
const servers = new Set();

async function serve(handler) {
  const server = createServer(handler);
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    relayUrl: `ws://127.0.0.1:${address.port}/ignored/socket?ignored=1`,
    server,
  };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  servers.clear();
});

test("positive safe integer advertisement is authoritative", () => {
  assert.deepEqual(
    parseRelayContentLimit(
      { limitation: { max_content_length: 524_288 } },
      LEGACY_BYTES,
    ),
    {
      advertisedMaxContentBytes: 524_288,
      effectiveMaxContentBytes: 524_288,
      reason: "max-content-length-advertised",
      source: "advertised",
    },
  );
  assert.equal(
    parseRelayContentLimit(
      { limitation: { max_content_length: 777_777 } },
      LEGACY_BYTES,
    ).effectiveMaxContentBytes,
    777_777,
  );
});

test("missing advertisement uses the named legacy assumption and ignores frame size", () => {
  for (const document of [
    {},
    { limitation: null },
    { limitation: {} },
    { limitation: { max_message_length: 1_048_576 } },
  ]) {
    assert.deepEqual(parseRelayContentLimit(document, LEGACY_BYTES), {
      advertisedMaxContentBytes: null,
      effectiveMaxContentBytes: LEGACY_BYTES,
      reason: "max-content-length-not-advertised",
      source: "legacy-assumption",
    });
  }
});

test("a present invalid advertisement fails instead of using the legacy assumption", () => {
  for (const value of [
    null,
    false,
    true,
    "524288",
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        parseRelayContentLimit(
          { limitation: { max_content_length: value } },
          LEGACY_BYTES,
        ),
      (error) => error?.code === "relay-info-invalid-max-content-length",
    );
  }
});

test("GET /info uses NIP-11 accept, rejects redirects, and does not retry", async () => {
  let calls = 0;
  const { relayUrl } = await serve((request, response) => {
    calls += 1;
    assert.equal(request.url, "/info");
    assert.equal(request.headers.accept, "application/nostr+json");
    response.writeHead(302, { Location: "/elsewhere" });
    response.end();
  });
  await assert.rejects(
    fetchRelayContentLimit(relayUrl),
    (error) => error?.code === "relay-info-redirect-rejected",
  );
  assert.equal(calls, 1);
});

test("GET /info returns advertised and canonical-root fallback provenance", async () => {
  const advertised = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/nostr+json" });
    response.end(
      JSON.stringify({ limitation: { max_content_length: 524_288 } }),
    );
  });
  assert.deepEqual(await fetchRelayContentLimit(advertised.relayUrl), {
    advertisedMaxContentBytes: 524_288,
    effectiveMaxContentBytes: 524_288,
    limitVerified: true,
    operationalAdvertisementConfirmed: false,
    reason: "max-content-length-advertised",
    infoEndpointHttpStatus: 200,
    relayInfoEndpoint: "/info",
    relayInfoHttpStatus: 200,
    relayInfoUrl: advertised.relayUrl.replace(
      /^ws:\/\/([^/]+).*$/,
      "http://$1/info",
    ),
    source: "advertised",
  });

  const unsupportedRequests = [];
  const unsupported = await serve((request, response) => {
    unsupportedRequests.push(request.url);
    if (request.url === "/info") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(
      JSON.stringify({ limitation: { max_message_length: 1_048_576 } }),
    );
  });
  assert.deepEqual(await fetchRelayContentLimit(unsupported.relayUrl), {
    advertisedMaxContentBytes: null,
    effectiveMaxContentBytes: LEGACY_BYTES,
    limitVerified: false,
    operationalAdvertisementConfirmed: false,
    reason: "relay-info-endpoint-unsupported",
    infoEndpointHttpStatus: 404,
    relayInfoEndpoint: "/",
    relayInfoHttpStatus: 200,
    relayInfoUrl: unsupported.relayUrl.replace(
      /^ws:\/\/([^/]+).*$/,
      "http://$1/",
    ),
    source: "legacy-assumption",
  });
  assert.deepEqual(unsupportedRequests, ["/info", "/"]);

  const rootAdvertised = await serve((request, response) => {
    if (request.url === "/info") {
      response.writeHead(501);
      response.end();
      return;
    }
    response.writeHead(200);
    response.end(
      JSON.stringify({ limitation: { max_content_length: 333_333 } }),
    );
  });
  assert.equal(
    (await fetchRelayContentLimit(rootAdvertised.relayUrl))
      .effectiveMaxContentBytes,
    333_333,
  );

  const bothUnsupported = await serve((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  const assumed = await fetchRelayContentLimit(bothUnsupported.relayUrl);
  assert.equal(assumed.effectiveMaxContentBytes, LEGACY_BYTES);
  assert.equal(assumed.source, "legacy-assumption");
  assert.equal(assumed.reason, "relay-info-endpoint-unsupported");
  assert.equal(assumed.limitVerified, false);
  assert.equal(assumed.infoEndpointHttpStatus, 405);
  assert.equal(assumed.relayInfoEndpoint, "/");
  assert.equal(assumed.relayInfoHttpStatus, 405);
});

test("an advertised 256 KiB value is verified and distinct from the equal legacy assumption", async () => {
  const advertised = await serve((_request, response) => {
    response.writeHead(200);
    response.end(
      JSON.stringify({ limitation: { max_content_length: LEGACY_BYTES } }),
    );
  });
  const verified = await fetchRelayContentLimit(advertised.relayUrl);
  assert.equal(verified.effectiveMaxContentBytes, LEGACY_BYTES);
  assert.equal(verified.advertisedMaxContentBytes, LEGACY_BYTES);
  assert.equal(verified.source, "advertised");
  assert.equal(verified.reason, "max-content-length-advertised");
  assert.equal(verified.limitVerified, true);

  const missing = await serve((_request, response) => {
    response.writeHead(200);
    response.end(JSON.stringify({ limitation: {} }));
  });
  const assumed = await fetchRelayContentLimit(missing.relayUrl);
  assert.equal(assumed.effectiveMaxContentBytes, LEGACY_BYTES);
  assert.equal(assumed.advertisedMaxContentBytes, null);
  assert.equal(assumed.source, "legacy-assumption");
  assert.equal(assumed.reason, "max-content-length-not-advertised");
  assert.equal(assumed.limitVerified, false);
});

test("HTTP, malformed JSON, and malformed document failures propagate", async () => {
  for (const [body, status, reason] of [
    ["{}", 500, "relay-info-http-error"],
    ["{", 200, "relay-info-invalid-json"],
    ["[]", 200, "relay-info-invalid-document"],
    ['{"limitation":"bad"}', 200, "relay-info-invalid-document"],
    [
      '{"limitation":{"max_content_length":1e400}}',
      200,
      "relay-info-invalid-max-content-length",
    ],
  ]) {
    const fixture = await serve((_request, response) => {
      response.writeHead(status);
      response.end(body);
    });
    await assert.rejects(
      fetchRelayContentLimit(fixture.relayUrl),
      (error) => error?.code === reason,
    );
  }
});

test("invalid UTF-8 response bytes fail with a stable reason", async () => {
  const fixture = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/nostr+json" });
    response.end(Buffer.from([0xc3, 0x28]));
  });
  await assert.rejects(
    fetchRelayContentLimit(fixture.relayUrl),
    (error) => error?.code === "relay-info-invalid-utf8",
  );
});

test("bounded response reading rejects declared and streamed overflow", async () => {
  const declared = await serve((_request, response) => {
    response.writeHead(200, { "Content-Length": "1000" });
    response.end("{}");
  });
  await assert.rejects(
    fetchRelayContentLimit(declared.relayUrl, { maxResponseBytes: 32 }),
    (error) => error?.code === "relay-info-response-too-large",
  );

  const streamed = await serve((_request, response) => {
    response.writeHead(200);
    response.write(`{${" ".repeat(64)}`);
    response.end("}");
  });
  await assert.rejects(
    fetchRelayContentLimit(streamed.relayUrl, { maxResponseBytes: 32 }),
    (error) => error?.code === "relay-info-response-too-large",
  );
});

test("timeout and network failures propagate stable reasons", async () => {
  const hanging = await serve(() => {});
  await assert.rejects(
    fetchRelayContentLimit(hanging.relayUrl, { timeoutMs: 20 }),
    (error) => error?.code === "relay-info-timeout",
  );

  const closed = await serve((_request, response) => response.end("{}"));
  await new Promise((resolve) => closed.server.close(resolve));
  servers.delete(closed.server);
  await assert.rejects(
    fetchRelayContentLimit(closed.relayUrl, { timeoutMs: 100 }),
    (error) => error?.code === "relay-info-network-failed",
  );
});

test("relay URL credentials and non-WebSocket schemes fail before fetch", async () => {
  for (const relayUrl of [
    "https://relay.example",
    "wss://user:secret@relay.example",
  ]) {
    await assert.rejects(
      fetchRelayContentLimit(relayUrl),
      (error) => error?.code === "invalid-relay-url",
    );
  }
});
