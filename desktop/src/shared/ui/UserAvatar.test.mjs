import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "a".repeat(64);
const externalUrl = `https://nostr.build/media/${HASH}.png`;
const relayUrl = `https://relay.example/media/${HASH}.png`;
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
class LoadedImage {
  complete = true;
  naturalWidth = 1;
  src = "";

  addEventListener() {}
  removeEventListener() {}
}
dom.window.Image = LoadedImage;
let commands = [];
let relayOrigin;
let proxyPort;
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
  HTMLElement: dom.window.HTMLElement,
  Image: LoadedImage,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, render, waitFor } = await import(
  "@testing-library/react"
);
const { UserAvatar } = await import("./UserAvatar.tsx");
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");

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

test("a cold avatar preserves an external Blossom URL before and after classification", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  assert.deepEqual(commands, [], "module import must not eagerly invoke IPC");
  const view = render(
    React.createElement(UserAvatar, {
      avatarUrl: externalUrl,
      displayName: "External avatar",
      fallbackDelayMs: 0,
    }),
  );

  const image = await view.findByRole("img", {
    name: "External avatar avatar",
  });
  assert.equal(image.getAttribute("src"), externalUrl);
  assert.deepEqual(commands, ["get_relay_http_url"]);
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54321);
  });
  await waitFor(() => assert.equal(image.getAttribute("src"), externalUrl));
  assert.deepEqual(commands, ["get_relay_http_url", "get_media_proxy_port"]);
});

test("a cold relay-owned avatar reacts to origin and port resolution", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(
    React.createElement(UserAvatar, {
      avatarUrl: relayUrl,
      displayName: "Relay avatar",
      fallbackDelayMs: 0,
    }),
  );

  const image = await view.findByRole("img", { name: "Relay avatar avatar" });
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

  relayOrigin = deferred();
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() => assert.equal(image.getAttribute("src"), relayUrl));
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54322);
  });
  await waitFor(() =>
    assert.equal(
      image.getAttribute("src"),
      `http://127.0.0.1:54322/media/${HASH}.png`,
    ),
  );
});

test("an unresolved workspace reset starts one fresh avatar media generation", async () => {
  const oldRelayOrigin = deferred();
  relayOrigin = oldRelayOrigin;
  proxyPort = deferred();
  const view = render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(UserAvatar, {
        avatarUrl: relayUrl,
        displayName: "Reset avatar",
        fallbackDelayMs: 0,
      }),
    ),
  );
  const image = await view.findByRole("img", { name: "Reset avatar avatar" });
  assert.equal(image.getAttribute("src"), relayUrl);
  assert.equal(
    commands.filter((command) => command === "get_relay_http_url").length,
    1,
    "StrictMode must share the initial in-flight lookup",
  );

  const nextRelayOrigin = deferred();
  relayOrigin = nextRelayOrigin;
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() =>
    assert.equal(
      commands.filter((command) => command === "get_relay_http_url").length,
      2,
      "reset must start exactly one new generation",
    ),
  );

  await act(async () => {
    oldRelayOrigin.resolve("https://stale-relay.example");
    await Promise.resolve();
  });
  assert.equal(image.getAttribute("src"), relayUrl);

  await act(async () => {
    nextRelayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54323);
  });
  await waitFor(() =>
    assert.equal(
      image.getAttribute("src"),
      `http://127.0.0.1:54323/media/${HASH}.png`,
    ),
  );

  view.unmount();
  const invokesBeforeUnmountedReset = commands.length;
  act(() => resetMediaCaches());
  await Promise.resolve();
  assert.equal(commands.length, invokesBeforeUnmountedReset);
});
