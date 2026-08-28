import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { deriveShellRoute } from "../../app/AppShell.helpers.ts";

const appSidebarSource = await readFile(
  new URL("../sidebar/ui/AppSidebarPinnedHeader.tsx", import.meta.url),
  "utf8",
);
const routeSource = await readFile(
  new URL("../../app/routes/ops.tsx", import.meta.url),
  "utf8",
).catch(() => "");

describe("native Ops Room route", () => {
  test("derives the Ops view from the route pathname", () => {
    assert.deepEqual(deriveShellRoute("/ops"), {
      selectedChannelId: null,
      selectedView: "ops",
    });
  });

  test("exposes the Ops view in the primary sidebar menu", () => {
    assert.match(appSidebarSource, /data-testid="open-ops-view"/);
  });

  test("registers the native Ops file route", () => {
    assert.match(routeSource, /createFileRoute\("\/ops"\)/);
  });
});
