import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  configureOpsWindow,
  opsLayoutForWidth,
  readOpsEvidenceSize,
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
