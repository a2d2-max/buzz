import { expect, test } from "@playwright/test";

import type { RelayEvent } from "../../src/shared/api/types";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const PROJECTS_ID = "11111111-2222-4333-8444-555555555555";
const SCORES_ID = "22222222-3333-4444-8555-666666666666";
const PROJECT_ROW_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const SCORE_ROW_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const author = TEST_IDENTITIES.tyler.pubkey;

function event(
  id: string,
  kind: 30624 | 30625,
  createdAt: number,
  tags: string[][],
  content: Record<string, unknown>,
): RelayEvent {
  return {
    id: id.repeat(64),
    pubkey: author,
    created_at: createdAt,
    kind,
    tags,
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

function schemaEvent({
  id,
  name,
  numberId,
  numberName,
  createdAt,
  eventId,
}: {
  id: string;
  name: string;
  numberId: string;
  numberName: string;
  createdAt: number;
  eventId: string;
}) {
  return event(
    eventId,
    30624,
    createdAt,
    [
      ["d", `db:${id}`],
      ["t", "community-db"],
    ],
    {
      name,
      properties: [
        { id: "title", name: "Name", type: "title" },
        {
          id: numberId,
          name: numberName,
          type: "number",
          options: { format: "decimal" },
        },
      ],
      views: [
        {
          id: "table",
          name: "Table",
          type: "table",
          sorts: [],
          visiblePropertyIds: ["title", numberId],
        },
      ],
      createdAt,
      updatedAt: createdAt,
    },
  );
}

function rowEvent({
  databaseId,
  eventId,
  rowId,
  createdAt,
  values,
}: {
  databaseId: string;
  eventId: string;
  rowId: string;
  createdAt: number;
  values: Record<string, unknown>;
}) {
  return event(
    eventId,
    30625,
    createdAt,
    [
      ["d", `dbrow:${rowId}`],
      ["t", "community-db-row"],
      ["db", databaseId],
    ],
    {
      values,
      docPageId: null,
      createdBy: author,
      createdAt,
      updatedAt: createdAt,
    },
  );
}

const databaseEvents = [
  schemaEvent({
    id: PROJECTS_ID,
    name: "Projects",
    numberId: "effort",
    numberName: "Effort",
    createdAt: 1_000,
    eventId: "1",
  }),
  schemaEvent({
    id: SCORES_ID,
    name: "Scores",
    numberId: "score",
    numberName: "Score",
    createdAt: 1_001,
    eventId: "2",
  }),
  rowEvent({
    databaseId: PROJECTS_ID,
    eventId: "3",
    rowId: PROJECT_ROW_ID,
    createdAt: 1_002,
    values: { title: "Alpha", effort: 3 },
  }),
  rowEvent({
    databaseId: SCORES_ID,
    eventId: "4",
    rowId: SCORE_ROW_ID,
    createdAt: 1_003,
    values: { title: "Target A", score: 4 },
  }),
];

async function acceptedCount(
  page: import("@playwright/test").Page,
  kind: number,
) {
  return page.evaluate(
    (eventKind) =>
      (window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? []).filter(
        (candidate) => candidate.kind === eventKind,
      ).length,
    kind,
  );
}

async function setComputedPanelOpen(
  page: import("@playwright/test").Page,
  open: boolean,
) {
  const toggle = page.getByRole("button", { name: "Computed property" });
  const expanded = (await toggle.getAttribute("aria-expanded")) === "true";
  if (expanded !== open) await toggle.click();
}

test("pairs relations, edits both sides, and resolves formulas and rollups", async ({
  page,
}) => {
  await installMockBridge(page, { databaseEvents });
  await page.goto("/");
  await page.getByTestId("open-databases-view").click();
  await page.getByTestId(`database-nav-${PROJECTS_ID}`).click();
  await expect(page.getByTestId("database-view-surface")).toBeVisible();

  await setComputedPanelOpen(page, true);
  await page.getByLabel("Related database").selectOption(SCORES_ID);
  await page.getByLabel("relation property name").fill("Scores");
  await page.getByLabel("Reciprocal property name").fill("Projects");

  await page.evaluate(() =>
    window.__BUZZ_E2E_FAIL_NEXT_DATABASE_PUBLISH__?.("relay offline"),
  );
  const schemasBeforePair = await acceptedCount(page, 30624);
  await page.getByRole("button", { name: "1. Save source relation" }).click();
  await expect(page.getByRole("alert")).toContainText("relay offline");
  await expect(acceptedCount(page, 30624)).resolves.toBe(schemasBeforePair);
  await page.getByRole("button", { name: "Retry computed property" }).click();
  await expect(
    page.getByRole("button", { name: "2. Create reciprocal property" }),
  ).toBeVisible();
  await expect
    .poll(() => acceptedCount(page, 30624))
    .toBe(schemasBeforePair + 1);
  await page
    .getByRole("button", { name: "2. Create reciprocal property" })
    .click();
  await expect
    .poll(() => acceptedCount(page, 30624))
    .toBe(schemasBeforePair + 2);

  const pair = await page.evaluate(
    ({ projectsId, scoresId }) => {
      const schemas = (window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? [])
        .filter((candidate) => candidate.kind === 30624)
        .map((candidate) => ({
          databaseId: candidate.tags.find((tag) => tag[0] === "d")?.[1],
          content: JSON.parse(candidate.content) as {
            properties: Array<{
              id: string;
              type: string;
              options?: {
                databaseId?: string;
                direction?: string;
                mirroredPropertyId?: string;
              };
            }>;
          },
        }));
      const owner = schemas
        .filter((candidate) => candidate.databaseId === `db:${projectsId}`)
        .at(-1)
        ?.content.properties.find(
          (property) =>
            property.type === "relation" &&
            property.options?.direction === "authoritative",
        );
      const mirror = schemas
        .filter((candidate) => candidate.databaseId === `db:${scoresId}`)
        .at(-1)
        ?.content.properties.find(
          (property) =>
            property.type === "relation" &&
            property.options?.direction === "mirror",
        );
      return { owner, mirror };
    },
    { projectsId: PROJECTS_ID, scoresId: SCORES_ID },
  );
  expect(pair.owner?.options?.mirroredPropertyId).toBe(pair.mirror?.id);
  expect(pair.mirror?.options?.mirroredPropertyId).toBe(pair.owner?.id);

  await page
    .getByRole("combobox", { name: "Choose row for Scores" })
    .selectOption(SCORE_ROW_ID);
  const rowsBeforeOwnerEdit = await acceptedCount(page, 30625);
  await page.getByRole("button", { name: "Add Scores relation" }).click();
  await expect
    .poll(() => acceptedCount(page, 30625))
    .toBe(rowsBeforeOwnerEdit + 1);
  await expect(page.getByText("Target A", { exact: true })).toBeVisible();

  await page.getByTestId(`database-nav-${SCORES_ID}`).click();
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible();
  await setComputedPanelOpen(page, false);
  const rowsBeforeMirrorRemove = await acceptedCount(page, 30625);
  await page.getByRole("button", { name: "Remove relation Alpha" }).click();
  await expect
    .poll(() => acceptedCount(page, 30625))
    .toBe(rowsBeforeMirrorRemove + 1);
  await page
    .getByRole("combobox", { name: "Choose row for Projects" })
    .selectOption(PROJECT_ROW_ID);
  const rowsBeforeMirrorAdd = await acceptedCount(page, 30625);
  await page.getByRole("button", { name: "Add Projects relation" }).click();
  await expect
    .poll(() => acceptedCount(page, 30625))
    .toBe(rowsBeforeMirrorAdd + 1);
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible();

  await page.getByTestId(`database-nav-${PROJECTS_ID}`).click();
  await setComputedPanelOpen(page, true);
  await page.getByRole("button", { name: "Formula" }).click();
  await page.getByLabel("formula property name").fill("Double effort");
  await page.getByLabel("Formula expression").fill('prop("Effort") * 2');
  await page.getByRole("button", { name: "Save formula" }).click();
  await expect(page.getByText("6", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Rollup" }).click();
  await page.getByLabel("rollup property name").fill("Total score");
  await page.getByLabel("Rollup relation").selectOption(pair.owner?.id ?? "");
  await page.getByLabel("Rollup target property").selectOption("score");
  await page.getByLabel("Rollup calculation").selectOption("sum");
  await page.getByRole("button", { name: "Save rollup" }).click();
  await expect(page.getByText("4", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Formula" }).click();
  await page.getByLabel("formula property name").fill("Broken formula");
  await page.getByLabel("Formula expression").fill("divide(1, 0)");
  await page.getByRole("button", { name: "Save formula" }).click();
  await expect(page.getByTestId("database-computed-errors")).toContainText(
    "DIVIDE_BY_ZERO",
  );

  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("open-databases-view").click();
  await page.getByTestId(`database-nav-${PROJECTS_ID}`).click();
  await expect(page.getByText("Target A", { exact: true })).toBeVisible();
  await expect(page.getByText("6", { exact: true })).toBeVisible();
  await expect(page.getByText("4", { exact: true })).toBeVisible();
  await expect(page.getByTestId("database-computed-errors")).toContainText(
    "DIVIDE_BY_ZERO",
  );

  await waitForAnimations(page);
  await page.getByTestId("databases-screen").screenshot({
    path: "test-results/notion-db-stage4/database-computed.png",
  });
});
