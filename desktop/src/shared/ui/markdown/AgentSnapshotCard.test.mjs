import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "a".repeat(64);
const relayUrl = `https://relay.example/media/${HASH}.png`;
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
let relayOrigin;
let proxyPort;
dom.window.__TAURI_INTERNALS__ = {
  invoke(command) {
    if (command === "get_media_proxy_port") return proxyPort.promise;
    if (command === "get_relay_http_url") return relayOrigin.promise;
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  },
};
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, render, waitFor } = await import(
  "@testing-library/react"
);
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const { AgentSnapshotCard } = await import("./AgentSnapshotCard.tsx");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  resetMediaCaches();
});

test("a cold relay-owned snapshot thumbnail reacts to media resolution", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(
    React.createElement(AgentSnapshotCard, {
      displayName: "Relay snapshot",
      filename: "relay.agent.png",
      href: relayUrl,
      onImport() {},
      sha256: HASH,
      snapshotKind: "agent",
      thumb: relayUrl,
    }),
  );

  const image = view.getByTestId("agent-snapshot-card-thumb");
  assert.equal(image.getAttribute("src"), relayUrl);
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54321);
  });
  await waitFor(() =>
    assert.equal(
      image.getAttribute("src"),
      `http://127.0.0.1:54321/media/${HASH}.png`,
    ),
  );
});
