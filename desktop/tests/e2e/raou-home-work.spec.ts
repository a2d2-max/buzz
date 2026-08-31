import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const generated_at = "2026-08-30T10:00:00Z";
const pageOf = (items: unknown[], next_cursor: string | null = null) => ({
  contract_version: 1 as const,
  revision: 31,
  generated_at,
  items,
  next_cursor,
});
const modules = [
  "work_items",
  "sessions",
  "checklist_items",
  "decisions",
  "approval_index",
  "evidence",
  "audit",
  "search",
] as const;
const capabilities = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: [],
  transitions: [],
  modules: modules.map((name) => ({
    name,
    schema_version: 1,
    paged: true,
    collection_revision: 31,
  })),
};
const workA = {
  id: "work:a",
  project_id: "project:raou",
  title: "Ship Home and Work",
  status: "active",
  progress: 0.6,
  last_activity_at: "2026-08-30T10:06:00Z",
  session_count: 1,
  approval_count: 1,
  artifact_count: 1,
};
const workB = {
  ...workA,
  id: "work:b",
  title: "Review evidence",
  status: "blocked",
  progress: 0.2,
  last_activity_at: "2026-08-30T09:00:00Z",
  session_count: 0,
  approval_count: 0,
  artifact_count: 0,
};
const strictPages = {
  sessions: pageOf([
    {
      id: "codex_direct:session-a",
      source: "codex_direct",
      parent_session_id: null,
      work_item_id: "work:a",
      title: "Landing worker",
      activity: "working",
      health: "live",
      last_activity_at: "2026-08-30T10:02:00Z",
      child_count: 0,
    },
  ]),
  checklist_items: pageOf([
    {
      id: "check:one",
      work_item_id: "work:a",
      key: "1",
      title: "First canonical step",
      order: 1,
      origin: "instruction",
      status: "done",
      evidence_ids: ["evidence:a"],
      claimed_by_session_id: null,
      claimed_at: null,
      stage: "plan",
      next_action: "Run full gate",
      depends_on: [],
      updated_at: "2026-08-30T10:03:00Z",
      revision: 1,
    },
  ]),
  decisions: pageOf([
    {
      id: "decision:a",
      work_item_id: "work:a",
      source: "checklist",
      source_id: "check:one",
      title: "Choose validation depth",
      question: "Which gate runs now?",
      options: ["Focused", "Full"],
      needed_input: "Select one",
      impact: "Changes completion time",
      queue: "user_decision",
      status: "open",
      updated_at: "2026-08-30T10:03:00Z",
      revision: 1,
    },
  ]),
  approval_index: pageOf([
    {
      id: "approval:a",
      work_item_id: "work:a",
      action_kind: "provider_run",
      status: "pending_approval",
      hold_reason: "Needs review",
      risk_class: ["dispatch_create"],
      updated_at: "2026-08-30T10:04:00Z",
      revision: 1,
    },
  ]),
  evidence: pageOf([
    {
      id: "evidence:a",
      work_item_id: "work:a",
      kind: "test_report",
      status: "verified",
      observed_at: "2026-08-30T10:05:00Z",
      artifact_id: "artifact:a",
      artifact_version: 1,
    },
  ]),
  audit: pageOf([
    {
      id: "audit:a",
      work_item_id: "work:a",
      kind: "work.updated",
      summary: "Checklist order confirmed",
      observed_at: "2026-08-30T10:06:00Z",
    },
  ]),
  search: pageOf([
    {
      id: "search:a",
      kind: "evidence",
      title: "Test report",
      snippet: "All focused tests passed",
      observed_at: "2026-08-30T10:05:00Z",
      work_item_id: "work:a",
    },
  ]),
};

async function openHome(page: Page, width: number, height: number, extra = {}) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMockBridge(
    page,
    {
      opsCapabilities: capabilities,
      opsPages: strictPages,
      opsPagesByCursor: {
        work_items: {
          first: pageOf([workA], "work-next"),
          "work-next": pageOf([workB]),
        },
      },
      ...extra,
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await page.goto("/?raouPrimary=1#/ops?view=home");
  await expect(
    page.getByRole("heading", { name: "Operational pulse" }),
  ).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "compact", width: 736, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`RAOU Home and Work stay complete at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await openHome(page, viewport.width, viewport.height);
    await expect(page.getByText("Landing worker")).toBeVisible();
    await expect(
      page.getByText("Choose validation depth").first(),
    ).toBeVisible();
    await expect(page.getByText("Checklist order confirmed")).toBeVisible();
    if (viewport.name === "desktop") {
      expect(
        await page.getByTestId("ops-home-view").evaluate((root) =>
          Array.from(root.querySelectorAll("*")).every((element) => {
            const style = getComputedStyle(element);
            return (
              style.animationDuration === "0s" &&
              style.transitionDuration === "0s"
            );
          }),
        ),
      ).toBe(true);
    }
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath(`raou-home-${viewport.name}.png`),
    });
    await page.getByRole("button", { name: /Ship Home and Work/ }).click();
    await expect(page).toHaveURL(/view=work/);
    await expect(
      page.getByRole("heading", { name: "Ship Home and Work" }),
    ).toBeVisible();
    await expect(page.getByText(/1 · First canonical step/)).toBeVisible();
    if (viewport.name === "mobile") {
      const trigger = page.getByRole("button", { name: "Choose work" });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Choose work" });
      await expect(dialog).toBeFocused();
      await page.locator("body").focus();
      await expect(dialog).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    await page.getByRole("tab", { name: "Attention" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Select one");
    await page.getByRole("tab", { name: "Evidence" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("artifact:a v1");
    await page
      .getByRole("searchbox", { name: "Search work" })
      .fill("  exact Query  ");
    await page.getByLabel("Search kind").selectOption("evidence");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("tabpanel")).toContainText(
      "All focused tests passed",
    );
    if (viewport.name === "desktop") {
      expect(
        await page.getByTestId("ops-work-view").evaluate((root) =>
          Array.from(root.querySelectorAll("*")).every((element) => {
            const style = getComputedStyle(element);
            return (
              style.animationDuration === "0s" &&
              style.transitionDuration === "0s"
            );
          }),
        ),
      ).toBe(true);
    }
    const payloads = await page.evaluate(
      () => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
    );
    const pageRequests = payloads
      .filter(({ command }) => command === "ops_bridge_page")
      .map(
        ({ payload }) =>
          (payload as { request: unknown }).request as Record<string, unknown>,
      );
    const workCursors = pageRequests
      .filter(({ module }) => module === "work_items")
      .map(({ cursor }) => cursor);
    expect(workCursors.length).toBeGreaterThanOrEqual(2);
    expect(workCursors.length % 2).toBe(0);
    for (let index = 0; index < workCursors.length; index += 2) {
      expect(workCursors.slice(index, index + 2)).toEqual([null, "work-next"]);
    }
    expect(
      pageRequests.find(({ module }) => module === "checklist_items")?.scope,
    ).toEqual({ work_item: "work:a", sort: "order_asc_then_id" });
    expect(
      pageRequests.find(({ module }) => module === "search")?.scope,
    ).toEqual({
      q: "  exact Query  ",
      kind: "evidence",
      work: "work:a",
      sort: "rank_desc_then_observed_at_desc",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        (window.__BUZZ_E2E_COMMANDS__ ?? []).filter((command) =>
          /ops_bridge_(?:create_draft|transition)/u.test(command),
        ),
      ),
    ).toEqual([]);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath(`raou-home-work-${viewport.name}.png`),
    });
  });
}

test("malformed evidence is isolated while audit remains visible", async ({
  page,
}) => {
  await openHome(page, 1280, 900, {
    opsPageErrors: { sessions: "unavailable" },
    opsRawPages: {
      evidence: {
        contract_version: 1,
        revision: 31,
        generated_at,
        items: [{ id: "broken" }],
        next_cursor: null,
      },
    },
  });
  await expect(
    page.getByText("Evidence contract is invalid.").first(),
  ).toBeVisible();
  await expect(
    page.getByText("Sessions is unavailable.").first(),
  ).toBeVisible();
  await expect(page.getByText("Checklist order confirmed")).toBeVisible();
  await page.getByRole("button", { name: /Ship Home and Work/ }).click();
  await expect(
    page.getByText("Read-only: collection mutations are disabled."),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window.__BUZZ_E2E_COMMANDS__ ?? []).filter((command) =>
        /ops_bridge_(?:create_draft|transition)/u.test(command),
      ),
    ),
  ).toEqual([]);
});
