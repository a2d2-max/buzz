import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "e".repeat(64);
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
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act, cleanup, render, waitFor } = await import(
  "@testing-library/react"
);
const categoryModule = await import("./emojiMartCategory.ts");
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const pickerSource = await readFile(
  new URL("./ui/EmojiPicker.tsx", import.meta.url),
  "utf8",
);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function CategoryProbe() {
  assert.equal(
    typeof categoryModule.useReactiveCustomEmojiCategory,
    "function",
  );
  const categories = categoryModule.useReactiveCustomEmojiCategory([
    { shortcode: "party_parrot", url: relayUrl },
  ]);
  return React.createElement(
    "output",
    { "data-testid": "picker-url" },
    categories?.[0].emojis[0].skins[0].src ?? "",
  );
}

afterEach(() => {
  cleanup();
  resetMediaCaches();
});

test("EmojiPicker consumes the reactive custom category instead of a URL-sticky memo", () => {
  assert.match(pickerSource, /useReactiveCustomEmojiCategory\(customEmoji\)/);
  assert.doesNotMatch(
    pickerSource,
    /useMemo\([\s\S]*buildCustomEmojiCategory\(customEmoji\)/,
  );
});

test("an open picker category follows cold relay resolution and cache reset", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(React.createElement(CategoryProbe));
  const output = view.getByTestId("picker-url");
  assert.equal(output.textContent, relayUrl);

  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54321);
  });
  await waitFor(() =>
    assert.equal(
      output.textContent,
      `http://127.0.0.1:54321/media/${HASH}.png`,
    ),
  );

  relayOrigin = deferred();
  proxyPort = deferred();
  act(() => resetMediaCaches());
  await waitFor(() => assert.equal(output.textContent, relayUrl));
  await act(async () => {
    relayOrigin.resolve("https://relay.example");
    await Promise.resolve();
    proxyPort.resolve(54322);
  });
  await waitFor(() =>
    assert.equal(
      output.textContent,
      `http://127.0.0.1:54322/media/${HASH}.png`,
    ),
  );
});
