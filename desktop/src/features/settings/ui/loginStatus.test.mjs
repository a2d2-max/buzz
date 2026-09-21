import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const cleanupPendingView = {
  running: false,
  retryStopping: true,
  tone: "error",
  headline: "Sign-in could not be fully stopped.",
  detail: "Retry stopping sign-in before starting another one.",
  offerSignInLink: false,
  justFinishedOk: false,
};

for (const [provider, modulePath, exportName] of [
  ["Codex", "./CodexLoginStatus.tsx", "CodexLoginStatus"],
  ["Claude", "./ClaudeLoginStatus.tsx", "ClaudeLoginStatus"],
]) {
  test(`${provider} cleanup-pending status retries the existing session`, async () => {
    const { createElement } = await import("react");
    const { fireEvent, render, screen } = await import(
      "@testing-library/react"
    );
    const module = await import(modulePath);
    let calls = 0;
    render(
      createElement(module[exportName], {
        accountId: `${provider.toLowerCase()}-account`,
        authUrl: null,
        cancelPending: false,
        onCancel: () => {
          calls += 1;
        },
        view: cleanupPendingView,
      }),
    );

    const retry = screen.getByRole("button", {
      name: "Retry stopping sign-in",
    });
    fireEvent.click(retry);
    assert.equal(calls, 1, "the existing cancel/retry command is invoked");
    assert.equal(
      screen.queryByRole("button", { name: "Cancel" }),
      null,
      "cleanup-pending is not presented as a still-running OAuth login",
    );
  });
}
