import { expect, test } from "@playwright/test";

import { createOpsRoomFixture } from "../../src/features/ops-room/testing/opsRoomFixture.mjs";
import { installMockBridge } from "../helpers/bridge";

const generated_at = "2026-08-30T10:00:00Z";
const page = (items: unknown[]) => ({
  contract_version: 1 as const,
  revision: 41,
  generated_at,
  items,
  next_cursor: null,
});
const paged = [
  "research",
  "repositories",
  "sessions",
  "approval_index",
  "evidence",
  "audit",
] as const;

const capabilities = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
  modules: [
    ...paged.map((name) => ({
      name,
      schema_version: 1,
      paged: true,
      collection_revision: 41,
    })),
    { name: "connections", schema_version: 1, paged: false },
    { name: "workflow_routing", schema_version: 1, paged: false },
  ],
};

const pages = {
  research: page([
    {
      id: "research:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Reader, Come Home",
      status: "complete",
      updated_at: generated_at,
    },
  ]),
  repositories: page([
    {
      id: "repository:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "buzz-fork-wrapper",
      branch: "feat/native-ops-wrapper",
      clean: true,
      ahead: 0,
      behind: 0,
    },
  ]),
  sessions: page([
    {
      id: "codex_direct:session-a",
      source: "codex_direct",
      parent_session_id: null,
      work_item_id: "work:a",
      title: "Landing worker",
      activity: "working",
      health: "live",
      last_activity_at: generated_at,
      child_count: 0,
    },
  ]),
  approval_index: page([
    {
      id: "approval:a",
      work_item_id: "work:a",
      action_kind: "provider_run",
      status: "pending_approval",
      hold_reason: "Needs review",
      risk_class: ["dispatch_create"],
      updated_at: generated_at,
      revision: 1,
    },
  ]),
  evidence: page([
    {
      id: "evidence:a",
      work_item_id: "work:a",
      kind: "test_report",
      status: "verified",
      observed_at: generated_at,
      artifact_id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      artifact_version: 1,
    },
  ]),
  audit: page([
    {
      id: "audit:a",
      work_item_id: "work:a",
      kind: "review.approved",
      summary: "Review evidence accepted",
      observed_at: generated_at,
    },
  ]),
};

function snapshot() {
  return createOpsRoomFixture({
    connections: [
      {
        id: "connection:hub",
        kind: "hub",
        locator_label: "Local Hub",
        name: "Local Hub",
        observed_at: generated_at,
        source_alias: `source:${"a".repeat(32)}`,
        status: "ready",
        updated_at: generated_at,
      },
    ],
    workflow_routing: {
      plans: [],
      routes: [
        {
          approval_boundary: "local_internal",
          effort: "high",
          enabled: true,
          from: "controller",
          id: "route:controller-codex",
          model: "codex",
          to: "codex",
        },
      ],
      routing: {
        allowed_efforts: ["high"],
        allowed_models: ["codex"],
        approval_boundaries: ["external_delivery"],
        controller: "controller",
        fallback: "forbidden",
        max_active_sessions: 4,
        observed_at: generated_at,
        schema_version: 1,
        source_sha256: "b".repeat(64),
        status: "ready",
      },
      status: "ready",
      superpowers: {
        manifest_sha256: "c".repeat(64),
        observed_at: generated_at,
        status: "ready",
        version: "6.3.0",
      },
    },
  });
}

async function selectSection(
  browser: import("@playwright/test").Page,
  label: string,
  mobile: boolean,
) {
  const navigationLabel = label === "Room" ? "Agent room" : label;
  if (!mobile) {
    await browser
      .getByRole("button", { name: navigationLabel, exact: true })
      .click();
    return;
  }
  const trigger = browser.getByRole("button", { name: "Toggle Sidebar" });
  await trigger.click();
  const navigation = browser.getByRole("navigation", {
    name: "RAOU workspace",
  });
  await expect(navigation).toBeVisible();
  const target = navigation.getByRole("button", {
    name: navigationLabel,
    exact: true,
  });
  expect(
    await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        Number.parseFloat(style.minWidth) >= 44 &&
        Number.parseFloat(style.minHeight) >= 44
      );
    }),
  ).toBe(true);
  await target.click();
  await expect(trigger).toBeFocused();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "compact", width: 736, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`existing signed source views stay complete at ${viewport.width}`, async ({
    page: browser,
  }, testInfo) => {
    await browser.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await browser.emulateMedia({ reducedMotion: "reduce" });
    await installMockBridge(
      browser,
      {
        opsCapabilities: capabilities,
        opsPages: pages,
        opsSnapshot: snapshot(),
      },
      {
        seedPreviewFeatures: false,
        skipCommunitySeed: true,
        skipOnboardingSeed: true,
      },
    );
    await browser.goto("/?raouPrimary=1#/ops?view=knowledge");
    await expect(
      browser.getByRole("heading", { name: "Knowledge", exact: true }),
    ).toBeVisible();
    await expect(browser.getByText("Reader, Come Home")).toBeVisible();

    await selectSection(browser, "Connections", viewport.width < 768);
    await expect(
      browser.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await expect(browser.getByText("buzz-fork-wrapper")).toBeVisible();
    await expect(
      browser.getByText(/read-only inbound activity only/i),
    ).toBeVisible();

    await selectSection(browser, "Routing", viewport.width < 768);
    await expect(
      browser.getByRole("heading", { name: "Routing", exact: true }),
    ).toBeVisible();
    await expect(browser.getByText("controller → codex")).toBeVisible();

    await selectSection(browser, "Safety", viewport.width < 768);
    await expect(
      browser.getByRole("heading", { name: "Safety", exact: true }),
    ).toBeVisible();
    await expect(browser.getByText("pending_approval")).toBeVisible();
    await browser.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath(`raou-source-${viewport.name}.png`),
    });

    await selectSection(browser, "Room", viewport.width < 768);
    await expect(
      browser.getByRole("heading", { name: "Agent Room", exact: true }),
    ).toBeVisible();
    expect(await browser.evaluate(() => document.getAnimations().length)).toBe(
      0,
    );
    expect(
      await browser.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      await browser.evaluate(() =>
        (window.__BUZZ_E2E_COMMANDS__ ?? []).filter((command) =>
          /ops_bridge_(?:create_draft|transition)/u.test(command),
        ),
      ),
    ).toEqual([]);
  });
}

test("source routes keep healthy signed pages visible while the snapshot command is disconnected", async ({
  page: browser,
}) => {
  await installMockBridge(
    browser,
    {
      opsCapabilities: capabilities,
      opsPages: pages,
      opsSnapshotError: "disconnected",
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await browser.goto("/?raouPrimary=1#/ops?view=connections");
  await expect(browser.getByText("buzz-fork-wrapper")).toBeVisible();
  await expect(browser.getByText("1 canonical session records")).toBeVisible();
  await expect(browser.getByText("Connections is unavailable.")).toBeVisible();
  await expect(browser.getByText("연결이 끊겼습니다")).toHaveCount(0);
});

test("a page transport exception stays local while its signed sibling remains visible", async ({
  page: browser,
}) => {
  await installMockBridge(
    browser,
    {
      opsCapabilities: capabilities,
      opsPageErrors: { evidence: "disconnected_once" },
      opsPages: pages,
      opsSnapshot: snapshot(),
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await browser.goto("/?raouPrimary=1#/ops?view=knowledge");
  await expect(browser.getByText("Reader, Come Home")).toBeVisible();
  await expect(
    browser
      .getByRole("region", { name: "Evidence sources" })
      .getByText("Evidence is disconnected."),
  ).toBeVisible();
  await expect(browser.getByText("연결이 끊겼습니다")).toHaveCount(0);
  await browser.getByRole("button", { name: "Retry Evidence" }).click();
  await expect(browser.getByText("evidence:a")).toBeVisible();
});

test("absent, unavailable, and malformed source modules stay isolated and fail closed", async ({
  page: browser,
}) => {
  await installMockBridge(
    browser,
    {
      opsCapabilities: {
        ...capabilities,
        modules: capabilities.modules.filter(({ name }) => name !== "research"),
      },
      opsPageErrors: { repositories: "unavailable" },
      opsRawPages: {
        evidence: {
          contract_version: 1,
          revision: 41,
          generated_at,
          items: [{ id: "malformed" }],
          next_cursor: null,
        },
      },
      opsPages: pages,
      opsSnapshot: snapshot(),
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await browser.goto("/?raouPrimary=1#/ops?view=knowledge");
  await expect(browser.getByText("Research is unavailable.")).toBeVisible();
  await expect(
    browser
      .getByRole("region", { name: "Evidence sources" })
      .getByText("Evidence contract is invalid."),
  ).toBeVisible();

  await selectSection(browser, "Connections", false);
  await expect(
    browser.getByText("Repositories contract is invalid."),
  ).toBeVisible();
  await expect(browser.getByText("Local Hub")).toBeVisible();

  await selectSection(browser, "Routing", false);
  await expect(browser.getByText("Review evidence accepted")).toBeVisible();
  await selectSection(browser, "Safety", false);
  await expect(
    browser.getByText("Read-only safety boundary is active."),
  ).toBeVisible();
  expect(
    await browser.evaluate(() =>
      (window.__BUZZ_E2E_COMMANDS__ ?? []).filter((command) =>
        /ops_bridge_(?:create_draft|transition)/u.test(command),
      ),
    ),
  ).toEqual([]);
});
