import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "d".repeat(64);
const relayUrl = `https://relay.example/media/${HASH}.png`;
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
let relayOrigin;
let proxyPort;
let commands = [];
dom.window.__TAURI_INTERNALS__ = {
  invoke(command) {
    commands.push(command);
    if (command === "get_media_proxy_port") return proxyPort.promise;
    if (command === "get_relay_http_url") return relayOrigin.promise;
    return Promise.reject(new Error(`Unexpected command: ${command}`));
  },
};
Object.assign(globalThis, {
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const { ViewImageToolPreview } = await import("./ViewImageToolPreview.tsx");

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
  commands = [];
});

test("a mounted viewed-image preview follows relay resolution and cache reset", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(
    React.createElement(ViewImageToolPreview, {
      src: relayUrl,
      title: "Viewed relay image",
    }),
  );
  const image = view.getByRole("img", { name: "Viewed relay image" });
  assert.equal(image.getAttribute("src"), relayUrl);
  fireEvent.error(image);
  assert.equal(view.queryByRole("img", { name: "Viewed relay image" }), null);

  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54321);
  });
  await waitFor(() =>
    assert.equal(
      view.getByRole("img", { name: "Viewed relay image" }).getAttribute("src"),
      `http://127.0.0.1:54321/media/${HASH}.png`,
    ),
  );

  relayOrigin = deferred();
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() =>
    assert.equal(view.queryByRole("img", { name: "Viewed relay image" }), null),
  );
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54322);
  });
  await waitFor(() =>
    assert.equal(
      view.getByRole("img", { name: "Viewed relay image" }).getAttribute("src"),
      `http://127.0.0.1:54322/media/${HASH}.png`,
    ),
  );
});

test("a failed agent image restarts after an unresolved workspace reset", async () => {
  const oldRelayOrigin = deferred();
  relayOrigin = oldRelayOrigin;
  proxyPort = deferred();
  const view = render(
    React.createElement(ViewImageToolPreview, {
      src: relayUrl,
      title: "Reset agent image",
    }),
  );
  fireEvent.error(view.getByRole("img", { name: "Reset agent image" }));
  assert.equal(view.queryByRole("img", { name: "Reset agent image" }), null);

  const nextRelayOrigin = deferred();
  relayOrigin = nextRelayOrigin;
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() =>
    assert.equal(
      commands.filter((command) => command === "get_relay_http_url").length,
      2,
    ),
  );
  await act(async () => {
    oldRelayOrigin.resolve("https://stale-relay.example");
    await Promise.resolve();
  });
  assert.equal(view.queryByRole("img", { name: "Reset agent image" }), null);

  await act(async () => {
    nextRelayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54323);
  });
  await waitFor(() =>
    assert.equal(
      view.getByRole("img", { name: "Reset agent image" }).getAttribute("src"),
      `http://127.0.0.1:54323/media/${HASH}.png`,
    ),
  );
});
