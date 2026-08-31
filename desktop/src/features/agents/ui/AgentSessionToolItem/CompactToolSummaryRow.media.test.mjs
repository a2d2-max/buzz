import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "c".repeat(64);
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
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const { CompactToolSummaryRow } = await import("./CompactToolSummaryRow.tsx");

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

test("a mounted remote agent thumbnail reacts when cold relay media resolves", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(
    React.createElement(CompactToolSummaryRow, {
      action: null,
      duration: null,
      fileEditSummary: null,
      kind: "image",
      label: "Preview",
      preview: "Agent image preview",
      thumbnailSrc: relayUrl,
    }),
  );
  const getImage = () => view.container.querySelector("img");
  const image = getImage();
  assert.ok(image);
  assert.equal(image.getAttribute("src"), relayUrl);
  fireEvent.error(image);
  assert.equal(getImage(), null);

  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54321);
  });
  await waitFor(() =>
    assert.equal(
      getImage()?.getAttribute("src"),
      `http://127.0.0.1:54321/media/${HASH}.png`,
    ),
  );

  relayOrigin = deferred();
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() => assert.equal(getImage(), null));
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54322);
  });
  await waitFor(() =>
    assert.equal(
      getImage()?.getAttribute("src"),
      `http://127.0.0.1:54322/media/${HASH}.png`,
    ),
  );
});
