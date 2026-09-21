import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    self: dom.window,
    window: dom.window,
  });
});
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
after(() => dom.window.close());

function schema(expression) {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Clock",
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "clock",
        name: "Clock",
        type: "formula",
        options: { expression, resultType: "date" },
      },
    ],
    views: [],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId: "1".repeat(64),
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

test("now and today advance on one minute clock and clean up on unmount", async () => {
  const React = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { databaseSchemasUseFormulaClock, useDatabaseFormulaClock } =
    await import("./useDatabaseFormulaClock.ts");
  assert.equal(databaseSchemasUseFormulaClock([schema("today()")]), true);
  assert.equal(databaseSchemasUseFormulaClock([schema('prop("Name")')]), false);

  const originalNow = Date.now;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  let now = 1_000;
  let callback;
  let cleared;
  Date.now = () => now;
  window.setInterval = (next, delay) => {
    assert.equal(delay, 60_000);
    callback = next;
    return 42;
  };
  window.clearInterval = (id) => {
    cleared = id;
  };

  try {
    function Probe() {
      const value = useDatabaseFormulaClock(
        new Map([[schema("now()").id, schema("now()")]]),
      );
      return React.createElement("output", null, String(value));
    }
    const view = render(React.createElement(Probe));
    assert.equal(view.getByRole("status").textContent, "1000");
    now = 61_000;
    await act(async () => callback());
    assert.equal(view.getByRole("status").textContent, "61000");
    view.unmount();
    assert.equal(cleared, 42);
  } finally {
    Date.now = originalNow;
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});
