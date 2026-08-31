import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { deriveShellRoute } from "../../app/AppShell.helpers.ts";

const appSidebarSource = await readFile(
  new URL("../sidebar/ui/AppSidebarPinnedHeader.tsx", import.meta.url),
  "utf8",
);
const appSidebarBridgeSource = await readFile(
  new URL("../sidebar/ui/AppSidebar.tsx", import.meta.url),
  "utf8",
);
const appShellSource = await readFile(
  new URL("../../app/AppShell.tsx", import.meta.url),
  "utf8",
);
const navigationSource = await readFile(
  new URL("../../app/navigation/useAppNavigation.ts", import.meta.url),
  "utf8",
);
const opsScreenSource = await readFile(
  new URL("./ui/OpsRoomScreen.tsx", import.meta.url),
  "utf8",
);
const opsRoomViewSource = await readFile(
  new URL("./ui/OpsRoomView.tsx", import.meta.url),
  "utf8",
);
const opsProjectionSource = await readFile(
  new URL("./opsProjection.ts", import.meta.url),
  "utf8",
);
const routeSource = await readFile(
  new URL("../../app/routes/ops.tsx", import.meta.url),
  "utf8",
).catch(() => "");
const routeTreeSource = await readFile(
  new URL("../../app/routeTree.gen.ts", import.meta.url),
  "utf8",
);
const virtualRoutesSource = await readFile(
  new URL("../../app/routes.ts", import.meta.url),
  "utf8",
);
const opsMenuSource =
  appSidebarSource.match(
    /<FeatureGate feature="nativeOpsRoom"[^>]*>[\s\S]*?<\/FeatureGate>/,
  )?.[0] ?? "";

describe("native Ops Room route", () => {
  test("derives the Ops view from the route pathname", () => {
    assert.deepEqual(deriveShellRoute("/ops"), {
      selectedChannelId: null,
      selectedView: "ops",
    });
  });

  test("wires the gated Ops selector through navigation and the sidebar", () => {
    assert.match(opsMenuSource, /data-testid="open-ops-view"/);
    assert.match(opsMenuSource, /forceEnabled=\{forceOpsVisible\}/);
    assert.match(opsMenuSource, /<PanelTop className="h-4 w-4" \/>/);
    assert.match(
      navigationSource,
      /const goOps = React\.useCallback\([\s\S]*?to: "\/ops"/,
    );
    assert.match(appShellSource, /onSelectOps=\{\(\) => void goOps\(\)\}/);
    assert.match(appSidebarBridgeSource, /onSelectOps=\{onSelectOps\}/);
  });

  test("keeps the Ops sidebar target at least 44px when expanded or collapsed", () => {
    assert.match(opsMenuSource, /className="[^"]*\bmin-h-11\b[^"]*"/);
    assert.match(opsMenuSource, /className="[^"]*\bmin-w-11\b[^"]*"/);
    assert.match(
      opsMenuSource,
      /className="[^"]*group-data-\[collapsible=icon\]:!size-11[^"]*"/,
    );
  });

  test("registers a lazy native Ops file route", () => {
    assert.match(routeSource, /createFileRoute\("\/ops"\)/);
    assert.match(
      routeSource,
      /React\.lazy\(async \(\) => \{[\s\S]*?import\("@\/features\/ops-room\/ui\/OpsRoomScreen"\)/,
    );
  });

  test("keeps Ops in the virtual and generated route trees", () => {
    assert.match(virtualRoutesSource, /route\("\/ops", "ops\.tsx"\)/);
    assert.match(routeTreeSource, /"\/ops": typeof opsRoute/);
  });

  test("composes the typed room leaves and keeps selection in the URL", () => {
    const composedRoomSource = `${opsScreenSource}\n${opsRoomViewSource}`;
    for (const component of [
      "OpsWorkspaceNav",
      "OpsSessionTree",
      "OpsTimeline",
      "OpsContextPanel",
      "OpsConnectionState",
    ]) {
      assert.match(composedRoomSource, new RegExp(`import.*${component}`));
    }
    assert.match(composedRoomSource, /min-h-0 min-w-0 flex-1/);
    assert.match(composedRoomSource, /\[overflow-wrap:anywhere\]/);
    assert.match(opsScreenSource, /OpsWorkspaceScreen/);
    assert.match(opsScreenSource, /OpsNavigationPort/);
    assert.match(
      opsProjectionSource,
      /new URLSearchParams\(\{ view: "room" \}\)/,
    );
  });
});
