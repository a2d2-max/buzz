import { expect, test } from "@playwright/test";

import type { RelayEvent } from "../../src/shared/api/types";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const LAUNCH_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const REVIEW_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const INLINE_PAGE_ID = "inline-database";
const LITERAL_PAGE_ID = "literal-database";
const MISSING_PAGE_ID = "missing-database";
const MISSING_DATABASE_ID = "99999999-9999-4999-8999-999999999999";
const author = TEST_IDENTITIES.tyler.pubkey;

function event(
  id: string,
  kind: 30623 | 30624 | 30625,
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
            { id: "todo", name: "To do", group: "todo" },
            { id: "doing", name: "In progress", group: "doing" },
            { id: "done", name: "Done", group: "done" },
          ],
        },
      },
      { id: "notes", name: "Notes", type: "text" },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title", "status", "notes"],
      },
      {
        id: "board",
        name: "Board",
        type: "board",
        sorts: [],
        group: { propertyId: "status", direction: "ascending" },
        visiblePropertyIds: ["title", "status", "notes"],
      },
      {
        id: "gallery",
        name: "Gallery",
        type: "gallery",
        sorts: [],
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

function docEvent(
  eventId: string,
  pageId: string,
  title: string,
  body: string,
  order: number,
) {
  return event(
    eventId,
    30623,
    2_000 + order,
    [
      ["d", `doc:${pageId}`],
      ["t", "community-doc"],
    ],
    {
      title,
      body,
      parentId: null,
      order,
      createdAt: 2_000_000,
      updatedAt: 2_000_000 + order,
    },
  );
}

const inlineBody = `Before the databases.\n\n:::db ${DATABASE_ID} table\n\nBetween the databases.\n\n:::db ${DATABASE_ID} gallery\n\nAfter the databases.`;
const literalBody = `\\:::db ${DATABASE_ID}\n\n\`\`\`\n:::db ${DATABASE_ID}\n\`\`\`\n\n- :::db ${DATABASE_ID}\n\n> :::db ${DATABASE_ID}`;
const databaseEvents = [
  schemaEvent,
  rowEvent("2", LAUNCH_ID, 1_001, {
    title: "Launch",
    status: "todo",
    notes: "Ship the desktop release",
  }),
  rowEvent("3", REVIEW_ID, 1_002, {
    title: "Review",
    status: "done",
    notes: "Check launch metrics",
  }),
];
const docEvents = [
  docEvent("a", INLINE_PAGE_ID, "Inline database", inlineBody, 0),
  docEvent("b", LITERAL_PAGE_ID, "Literal directives", literalBody, 1),
  docEvent(
    "c",
    MISSING_PAGE_ID,
    "Missing database",
    `:::db ${MISSING_DATABASE_ID}`,
    2,
  ),
];

async function acceptedCount(
  page: import("@playwright/test").Page,
  kind: 30623 | 30624 | 30625,
) {
  return page.evaluate(
    (eventKind) =>
      [
        ...(window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__ ?? []),
        ...(window.__BUZZ_E2E_ACCEPTED_DOC_EVENTS__ ?? []),
      ].filter((candidate) => candidate.kind === eventKind).length,
    kind,
  );
}

async function prosemirrorState(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".ProseMirror") as
      | (HTMLElement & {
          editor?: {
            state: {
              doc: { toJSON: () => unknown };
              selection: {
                anchor: number;
                from: number;
                head: number;
                to: number;
              };
            };
          };
          pmViewDesc?: {
            dom: HTMLElement;
          };
        })
      | null;
    const state = root?.editor?.state;
    if (!state) throw new Error("ProseMirror state is unavailable");
    return {
      doc: state.doc.toJSON(),
      selection: {
        anchor: state.selection.anchor,
        from: state.selection.from,
        head: state.selection.head,
        to: state.selection.to,
      },
    };
  });
}

test("Docs inline databases preserve editor ownership and shared persisted views", async ({
  page,
}) => {
  await installMockBridge(page, {
    databaseEvents,
    databaseHistoryDelayMs: 1_000,
    docEvents,
  });
  await page.goto("/");
  await page.getByTestId("open-legacy-docs-view").click();
  await page
    .getByTestId(`docs-tree-row-${INLINE_PAGE_ID}`)
    .getByRole("button", { name: "Inline database", exact: true })
    .click();

  const blocks = page.getByTestId(`doc-database-${DATABASE_ID}`);
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first().getByTestId("buzz-loading-state")).toBeVisible();
  const loadingHeights = await blocks
    .getByTestId("buzz-loading-state")
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height),
    );
  expect(loadingHeights).toHaveLength(2);
  expect(loadingHeights.every((height) => height < 200)).toBe(true);
  await expect(
    blocks.first().getByTestId("database-table-surface"),
  ).toBeVisible();
  await expect(
    blocks.nth(1).getByTestId("database-gallery-surface"),
  ).toBeVisible();
  await expect(acceptedCount(page, 30623)).resolves.toBe(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_DATABASE_QUERY_FILTERS__ ?? []).filter(
            (filter) => !filter["#d"],
          ).length,
      ),
    )
    .toBe(2);

  await blocks.first().getByRole("tab", { name: "Board" }).click();
  await expect(
    blocks.first().getByTestId("database-board-surface"),
  ).toBeVisible();
  await expect(acceptedCount(page, 30623)).resolves.toBe(0);

  await page.getByTestId("doc-start-edit").click();
  const editorBlock = blocks.first();
  await expect(editorBlock.getByTestId("database-table-surface")).toBeVisible();
  const beforeTableKeyboard = await prosemirrorState(page);
  const titleTrigger = editorBlock
    .getByRole("button", { name: "Edit Name" })
    .first();
  await titleTrigger.focus();
  await titleTrigger.press("ArrowRight");
  await expect(
    editorBlock.getByRole("button", { name: "Edit Status" }).first(),
  ).toBeFocused();
  expect(await prosemirrorState(page)).toEqual(beforeTableKeyboard);

  await page.evaluate(
    (remote) => window.__BUZZ_E2E_REPLACE_DATABASE_HEAD__?.(remote),
    rowEvent("4", LAUNCH_ID, 1_004, {
      title: "Launch",
      status: "todo",
      notes: "Remote note",
    }),
  );
  await titleTrigger.click();
  const titleInput = editorBlock.getByRole("textbox", { name: "Edit Name" });
  await titleInput.fill("Ready");
  await titleInput.evaluate((element) => {
    element.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, data: "R" }),
    );
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "Ready" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        clipboardData: new DataTransfer(),
      }),
    );
  });
  await titleInput.press("Enter");
  await expect(editorBlock.getByRole("alert")).toContainText("newer");
  await expect(acceptedCount(page, 30625)).resolves.toBe(0);
  await editorBlock.getByRole("button", { name: "Retry Name" }).click();
  await expect.poll(() => acceptedCount(page, 30625)).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = window.__BUZZ_E2E_ACCEPTED_DATABASE_EVENTS__?.at(-1);
        return event ? JSON.parse(event.content).values : null;
      }),
    )
    .toEqual({ title: "Ready", status: "todo", notes: "Remote note" });
  expect(await prosemirrorState(page)).toEqual(beforeTableKeyboard);
  await expect(acceptedCount(page, 30623)).resolves.toBe(0);

  await editorBlock.getByRole("tab", { name: "Board" }).click();
  await expect(editorBlock.getByTestId("database-board-surface")).toBeVisible();
  await expect.poll(() => acceptedCount(page, 30623)).toBe(1);
  const beforeBoard = await prosemirrorState(page);

  const pointerHandle = editorBlock.getByRole("button", {
    name: "Move Review",
  });
  const doingColumn = editorBlock.getByRole("region", {
    name: "In progress Status",
  });
  const pointerBox = await pointerHandle.boundingBox();
  const doingBox = await doingColumn.boundingBox();
  expect(pointerBox).not.toBeNull();
  expect(doingBox).not.toBeNull();
  await page.mouse.move(
    (pointerBox?.x ?? 0) + (pointerBox?.width ?? 0) / 2,
    (pointerBox?.y ?? 0) + (pointerBox?.height ?? 0) / 2,
  );
  await page.mouse.down();
  await page.mouse.move((doingBox?.x ?? 0) + 80, (doingBox?.y ?? 0) + 120, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(() => acceptedCount(page, 30625)).toBe(2);

  const keyboardHandle = editorBlock.getByRole("button", {
    name: "Move Ready",
  });
  await keyboardHandle.focus();
  await keyboardHandle.press("Space");
  await page.waitForTimeout(100);
  await keyboardHandle.press("ArrowRight");
  await page.waitForTimeout(100);
  await keyboardHandle.press("Space");
  await expect.poll(() => acceptedCount(page, 30625)).toBe(3);
  expect(await prosemirrorState(page)).toEqual(beforeBoard);

  await page.getByTestId("doc-finish-edit").click();
  await expect(page.getByTestId("doc-page-view")).toBeVisible();
  await expect(acceptedCount(page, 30623)).resolves.toBe(1);
  const savedBody = await page.evaluate(() => {
    const event = window.__BUZZ_E2E_ACCEPTED_DOC_EVENTS__?.at(-1);
    return event ? JSON.parse(event.content).body : null;
  });
  expect(savedBody).toBe(
    inlineBody.replace(
      `:::db ${DATABASE_ID} table`,
      `:::db ${DATABASE_ID} board`,
    ),
  );

  await waitForAnimations(page);
  await blocks.first().screenshot({
    path: "test-results/notion-db-stage5/database-inline-docs.png",
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "18px";
  });
  await waitForAnimations(page);
  await blocks.first().screenshot({
    path: "test-results/notion-db-stage5/database-inline-docs-18px.png",
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });

  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("open-legacy-docs-view").click();
  await page
    .getByTestId(`docs-tree-row-${INLINE_PAGE_ID}`)
    .getByRole("button", { name: "Inline database", exact: true })
    .click();
  await expect(
    blocks.first().getByTestId("database-board-surface"),
  ).toBeVisible();
  await blocks.first().getByRole("tab", { name: "Table" }).click();
  await expect(
    blocks.first().getByTestId("database-table-surface"),
  ).toBeVisible();
  await expect(acceptedCount(page, 30623)).resolves.toBe(1);

  await page
    .getByTestId(`docs-tree-row-${LITERAL_PAGE_ID}`)
    .getByRole("button", { name: "Literal directives", exact: true })
    .click();
  await expect(page.getByTestId("doc-page-view")).toContainText(
    `:::db ${DATABASE_ID}`,
  );
  await expect(page.getByTestId(`doc-database-${DATABASE_ID}`)).toHaveCount(0);
  await page.getByTestId("doc-start-edit").click();
  await expect(page.getByTestId("doc-source-input")).toHaveValue(literalBody);

  await page
    .getByTestId(`docs-tree-row-${MISSING_PAGE_ID}`)
    .getByRole("button", { name: "Missing database", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("missing or was deleted");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page
    .getByTestId(`docs-tree-row-${INLINE_PAGE_ID}`)
    .getByRole("button", { name: "Inline database", exact: true })
    .click();
  await page.getByTestId("doc-start-edit").click();
  const databaseWritesBeforeRemove = await acceptedCount(page, 30625);
  await blocks.first().getByRole("button", { name: "Remove block" }).click();
  await page.getByTestId("doc-finish-edit").click();
  await expect.poll(() => acceptedCount(page, 30623)).toBe(2);
  await expect(acceptedCount(page, 30625)).resolves.toBe(
    databaseWritesBeforeRemove,
  );
  const bodyAfterRemove = await page.evaluate(() => {
    const event = window.__BUZZ_E2E_ACCEPTED_DOC_EVENTS__?.at(-1);
    return event ? JSON.parse(event.content).body : null;
  });
  expect(bodyAfterRemove).toBe(
    `Before the databases.\n\nBetween the databases.\n\n:::db ${DATABASE_ID} gallery\n\nAfter the databases.`,
  );
});
