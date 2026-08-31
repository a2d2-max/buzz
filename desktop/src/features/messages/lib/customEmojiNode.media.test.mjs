import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const HASH = "f".repeat(64);
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
  window: dom.window,
});

const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const { CustomEmojiNode } = await import("./customEmojiNode.ts");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForValue(read, expected) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(read(), expected);
}

function createNodeView() {
  assert.equal(typeof CustomEmojiNode.config.addNodeView, "function");
  const factory = CustomEmojiNode.config.addNodeView.call({
    options: {
      resolveUrl: () => relayUrl,
      shortcodes: () => ["party_parrot"],
    },
  });
  return factory({
    node: {
      attrs: { shortcode: "party_parrot", src: relayUrl },
      type: { name: "customEmoji" },
    },
  });
}

afterEach(() => {
  resetMediaCaches();
});

test("the composer custom emoji node installs a disposable reactive node view", () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = createNodeView();
  assert.equal(view.dom.tagName, "IMG");
  assert.equal(typeof view.destroy, "function");
  view.destroy();
});

test("a mounted composer emoji follows cold relay resolution and cache reset", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = createNodeView();
  assert.equal(view.dom.getAttribute("src"), relayUrl);

  relayOrigin.resolve("https://relay.example");
  await Promise.resolve();
  proxyPort.resolve(54321);
  await waitForValue(
    () => view.dom.getAttribute("src"),
    `http://127.0.0.1:54321/media/${HASH}.png`,
  );

  relayOrigin = deferred();
  proxyPort = deferred();
  resetMediaCaches();
  await waitForValue(() => view.dom.getAttribute("src"), relayUrl);
  relayOrigin.resolve("https://relay.example");
  await Promise.resolve();
  proxyPort.resolve(54322);
  await waitForValue(
    () => view.dom.getAttribute("src"),
    `http://127.0.0.1:54322/media/${HASH}.png`,
  );
  view.destroy();
});
