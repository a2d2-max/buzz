import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

import {
  configureOpsWindow,
  opsLayoutForWidth,
  readOpsEvidenceSize,
  useOpsWindowSize,
} from "./opsWindowSize.ts";

function sizeRecord(size) {
  return { width: size.width, height: size.height };
}

describe("native Ops window sizing", () => {
  test("uses four-column, two-pane, and one-pane boundaries", () => {
    assert.equal(opsLayoutForWidth(1024), "desktop");
    assert.equal(opsLayoutForWidth(736), "compact");
    assert.equal(opsLayoutForWidth(640), "compact");
    assert.equal(opsLayoutForWidth(639), "mobile");
    assert.equal(opsLayoutForWidth(390), "mobile");
  });

  test("accepts only bounded DEV evidence dimensions", () => {
    assert.deepEqual(
      readOpsEvidenceSize(
        { VITE_OPS_EVIDENCE_WIDTH: "390", VITE_OPS_EVIDENCE_HEIGHT: "844" },
        true,
      ),
      { width: 390, height: 844 },
    );
    assert.equal(
      readOpsEvidenceSize(
        { VITE_OPS_EVIDENCE_WIDTH: "359", VITE_OPS_EVIDENCE_HEIGHT: "844" },
        true,
      ),
      null,
    );
    assert.equal(
      readOpsEvidenceSize(
        { VITE_OPS_EVIDENCE_WIDTH: "390", VITE_OPS_EVIDENCE_HEIGHT: "844" },
        false,
      ),
      null,
    );
  });

  test("lowers the minimum before evidence resize and restores 800x500 on cleanup", async () => {
    const calls = [];
    const nativeWindow = {
      async setMinSize(size) {
        calls.push(["min", sizeRecord(size)]);
      },
      async setSize(size) {
        calls.push(["size", sizeRecord(size)]);
      },
    };

    const cleanup = await configureOpsWindow(nativeWindow, {
      width: 736,
      height: 900,
    });
    await cleanup();

    assert.deepEqual(calls, [
      ["min", { width: 360, height: 500 }],
      ["size", { width: 736, height: 900 }],
      ["min", { width: 800, height: 500 }],
      ["size", { width: 800, height: 500 }],
    ]);
  });

  test("returns a working cleanup even when the evidence resize fails", async () => {
    const calls = [];
    const nativeWindow = {
      async setMinSize(size) {
        calls.push(["min", sizeRecord(size)]);
      },
      async setSize(size) {
        calls.push(["size", sizeRecord(size)]);
        if (size.width === 390) throw new Error("resize failed");
      },
    };

    const cleanup = await configureOpsWindow(nativeWindow, {
      width: 390,
      height: 844,
    });
    await cleanup();

    assert.deepEqual(calls.at(-2), ["min", { width: 800, height: 500 }]);
    assert.deepEqual(calls.at(-1), ["size", { width: 800, height: 500 }]);
  });

  test("StrictMode stale setup cannot restore over the active evidence window", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/#/ops?view=room",
    });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: dom.window.document },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      navigator: { configurable: true, value: dom.window.navigator },
      Node: { configurable: true, value: dom.window.Node },
      window: { configurable: true, value: dom.window },
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { act, cleanup, render } = await import("@testing-library/react");
    let resolveFirstMinimum;
    let minimumCalls = 0;
    let finalMinimum = null;
    let finalSize = null;
    const calls = [];
    const nativeWindow = {
      async setMinSize(size) {
        const record = sizeRecord(size);
        calls.push(["min", record]);
        minimumCalls += 1;
        if (minimumCalls === 1) {
          await new Promise((resolve) => {
            resolveFirstMinimum = resolve;
          });
        }
        finalMinimum = record;
      },
      async setSize(size) {
        const record = sizeRecord(size);
        calls.push(["size", record]);
        finalSize = record;
      },
    };

    function Harness() {
      useOpsWindowSize(nativeWindow, { width: 390, height: 844 });
      return null;
    }

    const view = render(
      React.createElement(React.StrictMode, null, React.createElement(Harness)),
    );
    await act(async () => Promise.resolve());
    assert.deepEqual(finalMinimum, { width: 360, height: 500 });
    assert.deepEqual(finalSize, { width: 390, height: 844 });

    await act(async () => {
      resolveFirstMinimum();
      await Promise.resolve();
    });
    assert.deepEqual(finalMinimum, { width: 360, height: 500 });
    assert.deepEqual(finalSize, { width: 390, height: 844 });

    view.unmount();
    await act(async () => Promise.resolve());
    assert.deepEqual(calls.at(-2), ["min", { width: 800, height: 500 }]);
    assert.deepEqual(calls.at(-1), ["size", { width: 800, height: 500 }]);
    cleanup();
    dom.window.close();
  });

  test("final StrictMode unmount waits for the active pending setup before restore", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/#/ops?view=room",
    });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: dom.window.document },
      HTMLElement: { configurable: true, value: dom.window.HTMLElement },
      navigator: { configurable: true, value: dom.window.navigator },
      Node: { configurable: true, value: dom.window.Node },
      window: { configurable: true, value: dom.window },
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { act, cleanup, render } = await import("@testing-library/react");
    const pendingMinimums = [];
    const calls = [];
    const nativeWindow = {
      setMinSize(size) {
        const record = sizeRecord(size);
        calls.push(["min", record]);
        if (record.width !== 360) return Promise.resolve();
        return new Promise((resolve) => pendingMinimums.push(resolve));
      },
      async setSize(size) {
        calls.push(["size", sizeRecord(size)]);
      },
    };

    function Harness() {
      useOpsWindowSize(nativeWindow, { width: 390, height: 844 });
      return null;
    }

    const view = render(
      React.createElement(React.StrictMode, null, React.createElement(Harness)),
    );
    await act(async () => Promise.resolve());
    assert.equal(pendingMinimums.length, 2);

    view.unmount();
    await act(async () => Promise.resolve());
    assert.equal(
      calls.some(([kind, size]) => kind === "min" && size.width === 800),
      false,
    );

    await act(async () => {
      pendingMinimums[0]();
      await Promise.resolve();
    });
    assert.equal(
      calls.some(([kind, size]) => kind === "min" && size.width === 800),
      false,
    );

    await act(async () => {
      pendingMinimums[1]();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(calls.at(-2), ["min", { width: 800, height: 500 }]);
    assert.deepEqual(calls.at(-1), ["size", { width: 800, height: 500 }]);
    cleanup();
    dom.window.close();
  });

  test("declares the two native window permissions", async () => {
    const capabilities = JSON.parse(
      await readFile(
        new URL(
          "../../../src-tauri/capabilities/default.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    assert.equal(
      capabilities.permissions.includes("core:window:allow-set-min-size"),
      true,
    );
    assert.equal(
      capabilities.permissions.includes("core:window:allow-set-size"),
      true,
    );
  });
});
