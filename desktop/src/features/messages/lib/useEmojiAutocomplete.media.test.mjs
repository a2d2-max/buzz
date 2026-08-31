import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const HASH = "b".repeat(64);
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
const { resetMediaCaches } = await import("@/shared/lib/mediaUrl");
const { useEmojiAutocomplete } = await import("./useEmojiAutocomplete.ts");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function AutocompleteProbe() {
  const autocomplete = useEmojiAutocomplete([
    { shortcode: "party_parrot", url: relayUrl },
  ]);
  React.useEffect(() => {
    autocomplete.updateEmojiQuery(":party", 6);
  }, [autocomplete.updateEmojiQuery]);
  const custom = autocomplete.emojiSuggestions.find(
    (suggestion) => suggestion.id === "party_parrot",
  );
  return React.createElement(
    "output",
    { "data-testid": "suggestion-url" },
    custom?.url ?? "",
  );
}

afterEach(() => {
  cleanup();
  resetMediaCaches();
});

test("an open custom emoji autocomplete reacts when cold relay media resolves", async () => {
  relayOrigin = deferred();
  proxyPort = deferred();
  const view = render(React.createElement(AutocompleteProbe));
  const output = view.getByTestId("suggestion-url");
  await waitFor(() => assert.equal(output.textContent, relayUrl));

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
