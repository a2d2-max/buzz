import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const UPSTREAM_HOST_COMMANDS = [
  "get_upstream_app_availability",
  "probe_upstream_app",
  "sync_upstream_app",
] as const;

async function invokedUpstreamHostCommands(
  page: import("@playwright/test").Page,
) {
  return page.evaluate(
    (commands) => {
      const invoked = window.__BUZZ_E2E_COMMANDS__ ?? [];
      return invoked.filter((command) =>
        commands.some((candidate) => candidate === command),
      );
    },
    [...UPSTREAM_HOST_COMMANDS],
  );
}

test("saved AFFiNE and Plane routes restore their renamed full native hosts", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/#/apps/affine");
  await expect(page).toHaveURL(/#\/apps\/affine$/);
  await expect(
    page.getByRole("heading", { name: "AFFiNE Docs" }),
  ).toBeVisible();
  await expect(page.getByTestId("upstream-app-host")).toBeVisible();
  await expect
    .poll(() => invokedUpstreamHostCommands(page))
    .toContain("probe_upstream_app");

  await page.goto("/#/apps/plane");
  await expect(page).toHaveURL(/#\/apps\/plane$/);
  await expect(
    page.getByRole("heading", { name: "Plane Board" }),
  ).toBeVisible();
  await expect(page.getByTestId("upstream-app-host")).toBeVisible();
  await expect
    .poll(() => invokedUpstreamHostCommands(page))
    .toContain("probe_upstream_app");
});

test("Docs and Board open full apps while legacy routes remain discoverable", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");

  const docsEntry = page.getByTestId("open-docs-view");
  const boardEntry = page.getByTestId("open-board-view");
  const legacyDocsEntry = page.getByTestId("open-legacy-docs-view");
  const legacyBoardEntry = page.getByTestId("open-legacy-board-view");
  await expect(docsEntry).toContainText("AFFiNE Docs");
  await expect(boardEntry).toContainText("Plane Board");
  await expect(legacyDocsEntry).toContainText("Legacy Docs");
  await expect(legacyBoardEntry).toContainText("Legacy Board");
  await expect(page.getByTestId(/^open-upstream-/)).toHaveCount(0);

  await docsEntry.click();
  await expect(page).toHaveURL(/#\/apps\/affine$/);
  await expect(page.getByTestId("upstream-app-host")).toBeVisible();

  await boardEntry.click();
  await expect(page).toHaveURL(/#\/apps\/plane$/);
  await expect(page.getByTestId("upstream-app-host")).toBeVisible();

  await legacyDocsEntry.click();
  await expect(page).toHaveURL(/#\/docs$/);

  await legacyBoardEntry.click();
  await expect(page).toHaveURL(/#\/board$/);
  await expect(page.getByTestId("community-board-tab-issues")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("upstream-app-host")).toHaveCount(0);
});
