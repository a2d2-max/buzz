import { expect, test } from "@playwright/test";

import type { RelayEvent } from "../../src/shared/api/types";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const LAUNCH_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEW_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const BACKLOG_ID = "cccccccc-3333-4333-8333-333333333333";
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

const schemaEvent = event(
  "1",
  30624,
  1_000,
  [
    ["d", `db:${DATABASE_ID}`],
    ["t", "community-db"],
  ],
  {
    name: "Product launch",
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: {
          choices: [
            { id: "done", name: "Done", group: "done" },
            { id: "todo", name: "To do", group: "todo" },
            { id: "doing", name: "In progress", group: "doing" },
          ],
        },
      },
      { id: "due", name: "Due", type: "date" },
      { id: "notes", name: "Notes", type: "text" },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [{ propertyId: "title", direction: "ascending" }],
        group: { propertyId: "status", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "due", "notes"],
        propertyWidths: { title: 264, status: 132, due: 180, notes: 240 },
      },
      {
        id: "board",
        name: "Board",
        type: "board",
        sorts: [{ propertyId: "title", direction: "ascending" }],
        group: { propertyId: "status", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "due"],
      },
      {
        id: "calendar",
        name: "Calendar",
        type: "calendar",
        sorts: [],
        group: { propertyId: "due", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "due"],
      },
      {
        id: "gallery",
        name: "Gallery",
        type: "gallery",
        sorts: [],
        group: { propertyId: "status", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "notes"],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  },
);

function rowEvent(
  eventId: string,
  rowId: string,
  createdAt: number,
  values: Record<string, unknown>,
) {
  return event(
    eventId,
    30625,
    createdAt,
    [
      ["d", `dbrow:${rowId}`],
      ["t", "community-db-row"],
      ["db", DATABASE_ID],
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
  schemaEvent,
  rowEvent("2", LAUNCH_ID, 1_001, {
    title: "Launch",
    status: "todo",
    due: { start: "2026-09-09", end: "2026-09-10", includeTime: false },
    notes: "Ship the desktop release",
  }),
  rowEvent("3", REVIEW_ID, 1_002, {
    title: "Review",
    status: "done",
    due: {
      start: "2026-09-11T09:00:00+09:00",
      end: "2026-09-11T10:00:00+09:00",
      includeTime: true,
    },
    notes: "Review launch metrics",
  }),
  rowEvent("4", BACKLOG_ID, 1_003, {
    title: "Backlog",
    status: null,
    due: null,
    notes: "Needs a date",
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

test("saved database views share rows and persist friendly configuration", async ({
  page,
}) => {
  await installMockBridge(page, { databaseEvents });
  await page.goto("/");
  await page.getByTestId("open-databases-view").click();
  await page.getByRole("button", { name: "Product launch" }).click();
  await expect(page.getByTestId("database-view-surface")).toBeVisible();

  await expect(page.getByRole("region", { name: "To do group" })).toContainText(
    "Launch",
  );
  await expect(page.getByRole("region", { name: "Empty group" })).toContainText(
    "Backlog",
  );
  await expect(page.getByRole("button", { name: "New row" })).toBeVisible();
  await expect(page.getByTestId(`database-cell-${LAUNCH_ID}-title`)).toHaveCSS(
    "width",
    "264px",
  );

  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter value").fill("Table draft");

  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page).toHaveURL(/view=board/);
  await expect(
    page.getByRole("button", { name: "Apply view settings" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "View settings" }).click();
  await expect(page.getByRole("button", { name: "Add filter" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("database-board-surface")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "To do Status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "In progress Status" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Done Status" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Empty Status" }),
  ).toBeVisible();

  const pointerHandle = page.getByRole("button", { name: "Move Review" });
  const doneColumn = page.getByRole("region", { name: "In progress Status" });
  const pointerBox = await pointerHandle.boundingBox();
  const doneBox = await doneColumn.boundingBox();
  expect(pointerBox).not.toBeNull();
  expect(doneBox).not.toBeNull();
  const rowWritesBeforePointer = await acceptedCount(page, 30625);
  const pointerX = (pointerBox?.x ?? 0) + (pointerBox?.width ?? 0) / 2;
  const pointerY = (pointerBox?.y ?? 0) + (pointerBox?.height ?? 0) / 2;
  await page.mouse.move(pointerX, pointerY);
  await page.mouse.down();
  await page.mouse.move(pointerX + 20, pointerY, { steps: 4 });
  await page.waitForTimeout(100);
  await page.mouse.move((doneBox?.x ?? 0) + 80, (doneBox?.y ?? 0) + 120, {
    steps: 8,
  });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await expect
    .poll(() => acceptedCount(page, 30625))
    .toBe(rowWritesBeforePointer + 1);

  const rowWritesBeforeKeyboard = await acceptedCount(page, 30625);
  const launchHandle = page.getByRole("button", { name: "Move Launch" });
  await launchHandle.focus();
  await launchHandle.press("Space");
  await page.waitForTimeout(100);
  await launchHandle.press("ArrowRight");
  await page.waitForTimeout(100);
  await launchHandle.press("Space");
  await expect
    .poll(() => acceptedCount(page, 30625))
    .toBe(rowWritesBeforeKeyboard + 1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events = (
          window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? []
        ).filter((candidate) => candidate.kind === 30625);
        return JSON.parse(events.at(-1)?.content ?? "{}").values?.status;
      }),
    )
    .toBe("doing");

  await waitForAnimations(page);
  await page.getByTestId("database-board-surface").screenshot({
    path: "test-results/notion-db-stage3/database-board.png",
  });

  await page.getByRole("tab", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/view=calendar/);
  await expect(page.getByTestId("database-calendar-surface")).toContainText(
    "Launch",
  );
  await expect(page.getByTestId("database-calendar-surface")).toContainText(
    "Review",
  );
  await expect(page.getByText("Needs date", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set date for Backlog" }).click();
  await page
    .getByRole("textbox", { name: "Date for Backlog", exact: true })
    .fill("2026-09-12");
  await page.getByLabel("End date for Backlog").fill("2026-09-13");
  const beforeDateSave = await acceptedCount(page, 30625);
  await page.getByRole("button", { name: "Save date for Backlog" }).click();
  await expect.poll(() => acceptedCount(page, 30625)).toBe(beforeDateSave + 1);
  await waitForAnimations(page);
  await page.getByTestId("database-calendar-surface").screenshot({
    path: "test-results/notion-db-stage3/database-calendar.png",
  });

  await page.getByRole("tab", { name: "Gallery" }).click();
  await expect(page).toHaveURL(/view=gallery/);
  await expect(page.getByTestId("database-gallery-surface")).toContainText(
    "Launch",
  );
  await expect(page.getByTestId("database-gallery-surface")).toContainText(
    "Review",
  );
  await page.getByRole("button", { name: "View settings" }).click();
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByLabel("Filter value").fill("Launch");
  await page.getByRole("button", { name: "Add sort" }).click();
  await page.getByLabel("Sort property").selectOption("status");
  const schemaWritesBefore = await acceptedCount(page, 30624);
  await page.getByRole("button", { name: "Apply view settings" }).click();
  await expect
    .poll(() => acceptedCount(page, 30624))
    .toBe(schemaWritesBefore + 1);
  await expect(page.getByTestId("database-gallery-surface")).toContainText(
    "Launch",
  );
  await expect(page.getByTestId("database-gallery-surface")).not.toContainText(
    "Review",
  );

  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("open-databases-view").click();
  await page.getByRole("button", { name: "Product launch" }).click();
  await page.getByRole("tab", { name: "Gallery" }).click();
  await expect(page).toHaveURL(/view=gallery/);
  await expect(page.getByTestId("database-gallery-surface")).toContainText(
    "Launch",
  );
  await expect(page.getByTestId("database-gallery-surface")).not.toContainText(
    "Review",
  );
  await waitForAnimations(page);
  await page.getByTestId("database-gallery-surface").screenshot({
    path: "test-results/notion-db-stage3/database-gallery.png",
  });
});
