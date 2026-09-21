import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

test("creates and edits a shared database through the signed relay bridge", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-databases-view").click();
  await expect(page.getByTestId("databases-screen")).toBeVisible();

  await page.getByRole("button", { name: "New database" }).click();
  await expect(page).toHaveURL(/\/databases\/[0-9a-f-]+$/);
  const databaseName = page.getByLabel("Database name");
  await databaseName.fill("Launch tracker");
  await databaseName.press("Enter");
  await expect(databaseName).toHaveValue("Launch tracker");

  await page.getByRole("button", { name: /Property$/ }).click();
  await page.getByLabel("Property name").fill("Priority");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: "Column settings for Priority" })
    .click();
  await page.getByLabel("Type for Priority").selectOption("select");
  await expect(
    page
      .getByRole("columnheader")
      .filter({ hasText: "Priority" })
      .getByText("Select", { exact: true }),
  ).toBeVisible();
  const choices = page.getByLabel("Choices for Priority");
  if (!(await choices.isVisible())) {
    await page
      .getByRole("button", { name: "Column settings for Priority" })
      .click();
  }
  await expect(choices).toBeVisible();
  await choices.fill("Ready, Blocked");
  await choices.blur();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__?.length ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(4);

  const width = page.getByLabel("Width for Priority");
  if (!(await width.isVisible())) {
    await page
      .getByRole("button", { name: "Column settings for Priority" })
      .click();
  }
  await width.fill("260");
  await width.dispatchEvent("pointerup");
  await page.getByRole("button", { name: "Move Priority left" }).click();
  if (
    !(await page.getByRole("button", { name: "Hide Priority" }).isVisible())
  ) {
    await page
      .getByRole("button", { name: "Column settings for Priority" })
      .click();
  }
  await page.getByRole("button", { name: "Hide Priority" }).click();
  await expect(
    page.getByRole("button", { name: "Show Priority" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show Priority" }).click();

  await page.getByRole("button", { name: /Property$/ }).click();
  await page.getByLabel("Property name").fill("Creator");
  await page.getByLabel("Property type").selectOption("created_by");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await page.getByRole("button", { name: "New row" }).click();
  await expect(page.getByRole("button", { name: "Edit Name" })).toBeVisible();
  await page.getByRole("button", { name: "Edit Name" }).click();
  const titleEditor = page.locator('input[aria-label="Edit Name"]');
  await titleEditor.fill("Ship desktop table");
  await titleEditor.press("Enter");
  await page.getByRole("button", { name: "Edit Priority" }).click();
  await page.locator('select[aria-label="Edit Priority"]').selectOption({
    label: "Ready",
  });

  const evidence = await expect
    .poll(() =>
      page.evaluate(() => ({
        accepted: window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? [],
        filters: window.__BUZZ_E2E_DATABASE_QUERY_FILTERS__ ?? [],
      })),
    )
    .toMatchObject({
      accepted: expect.arrayContaining([
        expect.objectContaining({ kind: 30624 }),
        expect.objectContaining({ kind: 30625 }),
      ]),
    });
  void evidence;

  const relayState = await page.evaluate(() => ({
    accepted: window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? [],
    filters: window.__BUZZ_E2E_DATABASE_QUERY_FILTERS__ ?? [],
  }));
  const schemas = relayState.accepted.filter((event) => event.kind === 30624);
  const rows = relayState.accepted.filter((event) => event.kind === 30625);
  const parsedSchemas = schemas.map((event) =>
    JSON.parse(event.content),
  ) as Array<{
    properties?: Array<{
      id: string;
      name: string;
      options?: { choices?: Array<{ id: string; name: string }> };
    }>;
    views?: Array<{
      visiblePropertyIds: string[];
      propertyWidths?: Record<string, number>;
    }>;
  }>;
  const latestSchema = parsedSchemas.at(-1) ?? {};
  const latestRow = JSON.parse(rows.at(-1)?.content ?? "{}") as {
    values?: Record<string, unknown>;
  };
  const priority = latestSchema.properties?.find(
    (property) => property.name === "Priority",
  );
  const ready = priority?.options?.choices?.find(
    (choice) => choice.name === "Ready",
  );
  expect(latestRow.values?.title).toBe("Ship desktop table");
  expect(latestRow.values?.[priority?.id ?? ""]).toBe(ready?.id);
  expect(latestSchema.views?.[0]?.propertyWidths?.[priority?.id ?? ""]).toBe(
    260,
  );
  expect(
    parsedSchemas.some(
      (schema) => schema.views?.[0]?.visiblePropertyIds[0] === priority?.id,
    ),
  ).toBe(true);
  expect(
    parsedSchemas.some(
      (schema) =>
        !schema.views?.[0]?.visiblePropertyIds.includes(priority?.id ?? ""),
    ),
  ).toBe(true);
  expect(
    relayState.filters.some(
      (filter) => filter.kinds?.includes(30624) && !Object.hasOwn(filter, "#t"),
    ),
  ).toBe(true);

  await expect(page.getByText(/deadbeef/)).toBeVisible();
  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("open-databases-view").click();
  await page.getByRole("button", { name: "Launch tracker" }).click();
  await expect(
    page.getByText("Ship desktop table", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Column settings for Priority" })
    .click();
  await page.getByLabel("Type for Priority").selectOption("text");
  await expect(
    page
      .getByRole("columnheader")
      .filter({ hasText: "Priority" })
      .getByText("Text", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("open-databases-view").click();
  await page.getByRole("button", { name: "Launch tracker" }).click();
  await page
    .getByRole("button", { name: "Column settings for Priority" })
    .click();
  await page
    .getByRole("button", { name: "Restore Priority as select" })
    .click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Priority" }).click();
  await page.locator('select[aria-label="Edit Priority"]').selectOption("");
  await expect
    .poll(() =>
      page.evaluate((propertyId) => {
        const rows = (
          window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? []
        ).filter((event) => event.kind === 30625);
        const latest = JSON.parse(rows.at(-1)?.content ?? "{}") as {
          values?: Record<string, unknown>;
        };
        return latest.values?.[propertyId];
      }, priority?.id ?? ""),
    )
    .toBeNull();
  await page.getByRole("button", { name: "Edit Priority" }).click();
  await page.locator('select[aria-label="Edit Priority"]').selectOption({
    label: "Ready",
  });
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  const firstCell = page.getByRole("button", { name: "Edit Name" });
  await firstCell.focus();
  await firstCell.press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Edit Priority" }),
  ).toBeFocused();
  expect(
    relayState.filters.some(
      (filter) => filter.kinds?.includes(30625) && !Object.hasOwn(filter, "#t"),
    ),
  ).toBe(true);

  await waitForAnimations(page);
  await page.getByTestId("databases-screen").screenshot({
    path: "test-results/notion-db-stage2/databases-table.png",
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "18px";
  });
  await expect(
    page.getByText("Ship desktop table", { exact: true }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.getByTestId("databases-screen").screenshot({
    path: "test-results/notion-db-stage2/databases-table-zoomed.png",
  });
});
