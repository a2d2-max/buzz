import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { dueToDateInputValue } from "../lib/communityTaskDue.ts";
import { installBoardTestDom } from "./communityTaskTestDom.mjs";

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

async function renderDialog(overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider.tsx");
  const { CommunityTaskDialog } = await import("./CommunityTaskDialog.tsx");
  const created = [];
  const openChanges = [];
  const props = {
    isCreating: false,
    onCreate: async (draft) => {
      created.push(draft);
    },
    onOpenChange: (open) => openChanges.push(open),
    open: true,
    ...overrides,
  };
  const result = render(
    createElement(
      ThemeProvider,
      null,
      createElement(CommunityTaskDialog, props),
    ),
  );
  return { ...result, created, openChanges };
}

function field(testId) {
  return globalThis.document.body.querySelector(`[data-testid='${testId}']`);
}

test("creating a task hands back the trimmed title, body, and due day", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { created, openChanges } = await renderDialog();

  assert.ok(field("community-task-dialog"), "dialog renders via portal");
  assert.equal(
    field("community-task-dialog-submit").disabled,
    true,
    "submit waits for a title",
  );

  fireEvent.change(field("community-task-dialog-title"), {
    target: { value: "  Plan the offsite  " },
  });
  fireEvent.change(field("community-task-dialog-body"), {
    target: { value: "- venue\n- dates\n" },
  });
  fireEvent.change(field("community-task-dialog-due"), {
    target: { value: "2026-09-30" },
  });
  assert.equal(field("community-task-dialog-submit").disabled, false);

  await act(async () => {
    fireEvent.submit(field("community-task-dialog").querySelector("form"));
  });

  assert.equal(created.length, 1);
  const [draft] = created;
  assert.equal(draft.title, "Plan the offsite");
  assert.equal(draft.body, "- venue\n- dates");
  assert.equal(dueToDateInputValue(draft.due), "2026-09-30");
  assert.deepEqual(openChanges, [false], "the dialog asks to close");
});

test("a rejected create keeps the dialog open and shows the reason", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { openChanges } = await renderDialog({
    onCreate: async () => {
      throw new Error("Relay said no.");
    },
  });

  fireEvent.change(field("community-task-dialog-title"), {
    target: { value: "Doomed" },
  });
  await act(async () => {
    fireEvent.submit(field("community-task-dialog").querySelector("form"));
  });

  assert.equal(
    field("community-task-dialog-error")?.textContent,
    "Relay said no.",
  );
  assert.deepEqual(openChanges, []);
});

test("no due date means the draft carries none", async () => {
  const { act, fireEvent } = await import("@testing-library/react");
  const { created } = await renderDialog();

  fireEvent.change(field("community-task-dialog-title"), {
    target: { value: "Undated" },
  });
  await act(async () => {
    fireEvent.submit(field("community-task-dialog").querySelector("form"));
  });

  assert.deepEqual(created, [{ title: "Undated", body: "" }]);
});
