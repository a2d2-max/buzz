import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { installBoardTestDom, makeTask } from "./communityTaskTestDom.mjs";

const AUTHOR = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);

let dom;

before(() => {
  dom = installBoardTestDom();
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (command) => Promise.reject(new Error(`unmocked: ${command}`)),
    transformCallback: () => 1,
  };
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const TEST_QUERY_DEFAULTS = {
  mutations: { gcTime: 0, retry: false },
  queries: {
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  },
};

async function renderSheet(overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider.tsx");
  const { CommunityTaskSheet } = await import("./CommunityTaskSheet.tsx");
  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  const saved = [];
  const deletes = [];
  const openChanges = [];
  const props = {
    canDelete: true,
    canEdit: true,
    isSaving: false,
    onDelete: async () => {
      deletes.push(true);
    },
    onOpenChange: (open) => openChanges.push(open),
    onSave: async (content) => {
      saved.push(content);
    },
    open: true,
    task: makeTask({
      assignees: [ASSIGNEE],
      body: "Bring the projector.",
      due: 1_800_000_000,
      title: "Book the room",
    }),
    viewerPubkey: AUTHOR,
    ...overrides,
  };
  const result = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ThemeProvider,
        null,
        createElement(CommunityTaskSheet, props),
      ),
    ),
  );
  return { ...result, deletes, openChanges, queryClient, saved };
}

function field(testId) {
  return globalThis.document.body.querySelector(`[data-testid='${testId}']`);
}

test("an editor sees the card's values and saves the edited content", async (t) => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { queryClient, saved } = await renderSheet();
  t.after(() => queryClient.clear());

  assert.equal(field("community-task-sheet-title").value, "Book the room");
  assert.equal(field("community-task-sheet-status").value, "todo");
  assert.equal(
    field("community-task-sheet-body").value,
    "Bring the projector.",
  );
  assert.equal(
    globalThis.document.body.querySelectorAll(
      "[data-testid='community-task-assignee-chip']",
    ).length,
    1,
  );

  fireEvent.change(field("community-task-sheet-title"), {
    target: { value: " Book the big room " },
  });
  fireEvent.change(field("community-task-sheet-status"), {
    target: { value: "doing" },
  });
  fireEvent.change(field("community-task-sheet-due"), {
    target: { value: "" },
  });
  fireEvent.click(field(`community-task-unassign-${ASSIGNEE}`));
  await act(async () => {
    fireEvent.submit(field("community-task-form"));
  });

  assert.equal(saved.length, 1);
  const [content] = saved;
  assert.equal(content.title, "Book the big room");
  assert.equal(content.status, "doing");
  assert.equal(content.body, "Bring the projector.");
  assert.deepEqual(content.assignees, []);
  assert.equal("due" in content, false, "a cleared due date is dropped");
  assert.equal(content.author, AUTHOR);
  assert.equal(content.createdAt, 100, "creation stamp is preserved");
});

test("assign to me adds the viewer to the draft", async (t) => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { queryClient, saved } = await renderSheet({
    task: makeTask({ assignees: [] }),
  });
  t.after(() => queryClient.clear());

  fireEvent.click(field("community-task-assign-self"));
  assert.equal(field("community-task-assign-self"), null, "already assigned");
  await act(async () => {
    fireEvent.submit(field("community-task-form"));
  });
  assert.deepEqual(saved[0].assignees, [AUTHOR]);
});

test("delete asks once more before calling through", async (t) => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { deletes, queryClient } = await renderSheet();
  t.after(() => queryClient.clear());

  assert.equal(field("community-task-sheet-delete-confirm"), null);
  fireEvent.click(field("community-task-sheet-delete"));
  assert.deepEqual(deletes, []);
  fireEvent.click(field("community-task-sheet-delete-cancel"));
  assert.equal(field("community-task-sheet-delete-confirm"), null);

  fireEvent.click(field("community-task-sheet-delete"));
  await act(async () => {
    fireEvent.click(field("community-task-sheet-delete-confirm"));
  });
  assert.deepEqual(deletes, [true]);
});

test("an assignee can edit but not delete", async (t) => {
  const { queryClient } = await renderSheet({
    canDelete: false,
    viewerPubkey: ASSIGNEE,
  });
  t.after(() => queryClient.clear());

  assert.ok(field("community-task-form"));
  assert.ok(field("community-task-sheet-save"));
  assert.equal(field("community-task-sheet-delete"), null);
});

test("everyone else gets a read-only card", async (t) => {
  const { queryClient } = await renderSheet({
    canDelete: false,
    canEdit: false,
    task: makeTask({ body: "", status: "doing", title: "Read me" }),
    viewerPubkey: "c".repeat(64),
  });
  t.after(() => queryClient.clear());

  assert.equal(field("community-task-form"), null);
  assert.ok(field("community-task-readonly"));
  assert.equal(field("community-task-readonly-status").textContent, "Doing");
  assert.equal(field("community-task-sheet-save"), null);
  assert.equal(field("community-task-assign-self"), null);
});

test("a rejected save surfaces the reason and keeps the sheet open", async (t) => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { openChanges, queryClient } = await renderSheet({
    onSave: async () => {
      throw new Error("Relay is away.");
    },
  });
  t.after(() => queryClient.clear());

  await act(async () => {
    fireEvent.submit(field("community-task-form"));
  });
  assert.equal(
    field("community-task-sheet-error")?.textContent,
    "Relay is away.",
  );
  assert.deepEqual(openChanges, []);
});
