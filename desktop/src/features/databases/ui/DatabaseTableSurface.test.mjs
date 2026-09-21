import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const ROW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    ResizeObserver: NoopObserver,
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        ["Element", "Node", "Event", "MouseEvent", "KeyboardEvent"].includes(
          key,
        ))
    ) {
      globalThis[key] = dom.window[key];
    }
  }
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

function schema() {
  return {
    id: DATABASE_ID,
    name: "Work",
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "notes", name: "Notes", type: "text" },
      { id: "created", name: "Created", type: "created_by" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "integer" },
      },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title", "notes", "created", "effort"],
        propertyWidths: {},
      },
    ],
    createdAt: 1,
    updatedAt: 2,
    author: "a".repeat(64),
    eventId: "1".repeat(64),
    eventCreatedAt: 2,
    eventKind: 30624,
    deleted: false,
  };
}

function row() {
  return {
    id: ROW_ID,
    databaseId: DATABASE_ID,
    values: { title: "Original", notes: "Keep", effort: "raw effort" },
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt: 1,
    updatedAt: 2,
    author: "b".repeat(64),
    eventId: "2".repeat(64),
    eventCreatedAt: 2,
    eventKind: 30625,
    deleted: false,
  };
}

test("failed cell save keeps the full-row draft and retries the same snapshot", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const calls = [];
  let fail = true;
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: schema(),
      rows: [row()],
      viewId: "table",
      onAddRow: async () => row(),
      onSaveSchema: async () => schema(),
      onSaveRowValues: async (_id, values, baseEventId) => {
        calls.push({ values, baseEventId });
        if (fail) {
          fail = false;
          throw new Error("relay offline");
        }
        return { ...row(), values, eventId: "3".repeat(64) };
      },
    }),
  );
  fireEvent.click(view.getByTestId(`database-cell-${ROW_ID}-title`));
  const input = view.getByLabelText("Edit Name");
  fireEvent.change(input, { target: { value: "Draft" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const retry = await view.findByRole("button", { name: "Retry Name" });
  assert.equal(view.getByLabelText("Edit Name").value, "Draft");
  assert.deepEqual(calls[0], {
    values: { title: "Draft", notes: "Keep", effort: "raw effort" },
    baseEventId: "2".repeat(64),
  });
  fireEvent.click(retry);
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], calls[0]);
});

test("automatic and mismatched cells expose honest read-only and recovery UI", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const schemas = [];
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: schema(),
      rows: [row()],
      viewId: "table",
      onAddRow: async () => row(),
      onSaveSchema: async (content) => {
        schemas.push(content);
        return { ...schema(), ...content, eventId: "4".repeat(64) };
      },
      onSaveRowValues: async () => row(),
    }),
  );
  assert.equal(view.queryByLabelText("Edit Created"), null);
  assert.match(
    view.getByTestId(`database-cell-${ROW_ID}-effort`).textContent,
    /raw effort/,
  );
  assert.match(
    view.getByTestId(`database-cell-${ROW_ID}-effort`).textContent,
    /Type mismatch/,
  );
  fireEvent.click(view.getByRole("button", { name: "Restore Effort as text" }));
  await waitFor(() => assert.equal(schemas.length, 1));
  assert.equal(
    schemas[0].properties.find((property) => property.id === "effort").type,
    "text",
  );
});

test("a fresh select column can define choices and persist a selected option", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const schemas = [];
  const rows = [];
  let eventSerial = 4;
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: schema(),
      rows: [{ ...row(), values: { title: "Original", notes: "Keep" } }],
      viewId: "table",
      onAddRow: async () => row(),
      onSaveSchema: async (content) => {
        schemas.push(content);
        eventSerial += 1;
        return {
          ...schema(),
          ...content,
          eventId: eventSerial.toString().repeat(64).slice(0, 64),
        };
      },
      onSaveRowValues: async (_id, values) => {
        rows.push(values);
        return { ...row(), values, eventId: "9".repeat(64) };
      },
    }),
  );

  fireEvent.click(view.getByRole("button", { name: /property/i }));
  fireEvent.change(view.getByLabelText("Property name"), {
    target: { value: "Priority" },
  });
  fireEvent.change(view.getByLabelText("Property type"), {
    target: { value: "select" },
  });
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  const settings = await waitFor(() => {
    const button = view.getByRole("button", {
      name: "Column settings for Priority",
    });
    assert.equal(button.disabled, false);
    return button;
  });
  fireEvent.click(settings);
  const choices = await view.findByLabelText("Choices for Priority");
  fireEvent.change(choices, { target: { value: "Ready, Blocked" } });
  fireEvent.blur(choices);
  await waitFor(() =>
    assert.equal(
      schemas.at(-1).properties.find((property) => property.name === "Priority")
        .options.choices.length,
      2,
    ),
  );
  const property = schemas
    .at(-1)
    .properties.find((candidate) => candidate.name === "Priority");
  const ready = property.options.choices.find(
    (choice) => choice.name === "Ready",
  );
  fireEvent.click(view.getByTestId(`database-cell-${ROW_ID}-${property.id}`));
  fireEvent.change(view.getByLabelText("Edit Priority"), {
    target: { value: ready.id },
  });
  await waitFor(() => assert.equal(rows.length, 1));
  assert.equal(rows[0][property.id], ready.id);
});

test("number clearing and timed date intervals persist their exact wire values", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const typedSchema = schema();
  typedSchema.properties.push({ id: "due", name: "Due", type: "date" });
  typedSchema.views[0].visiblePropertyIds.push("due");
  const typedRow = {
    ...row(),
    values: { title: "Original", notes: "Keep", effort: 4 },
  };
  const saved = [];
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: typedSchema,
      rows: [typedRow],
      viewId: "table",
      onAddRow: async () => typedRow,
      onSaveSchema: async () => typedSchema,
      onSaveRowValues: async (_id, values) => {
        saved.push(values);
        return {
          ...typedRow,
          values,
          eventId: `${saved.length + 5}`.repeat(64),
        };
      },
    }),
  );

  fireEvent.click(view.getByTestId(`database-cell-${ROW_ID}-effort`));
  const number = view.getByLabelText("Edit Effort");
  fireEvent.change(number, { target: { value: "" } });
  fireEvent.keyDown(number, { key: "Enter" });
  await waitFor(() => assert.equal(saved.length, 1));
  assert.equal(saved[0].effort, null);

  fireEvent.click(view.getByTestId(`database-cell-${ROW_ID}-due`));
  fireEvent.change(view.getByLabelText("Edit Due start"), {
    target: { value: "2026-09-09" },
  });
  fireEvent.change(view.getByLabelText("Edit Due end"), {
    target: { value: "2026-09-10" },
  });
  fireEvent.click(view.getByLabelText("Include time"));
  fireEvent.change(view.getByLabelText("Edit Due start"), {
    target: { value: "2026-09-09T09:30" },
  });
  fireEvent.change(view.getByLabelText("Edit Due end"), {
    target: { value: "2026-09-10T10:45" },
  });
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(saved.length, 2));
  assert.equal(saved[1].due.includeTime, true);
  assert.match(saved[1].due.start, /^2026-09-09T.*Z$/);
  assert.match(saved[1].due.end, /^2026-09-10T.*Z$/);
});

test("a rejected draft rebases onto a newer full row before retry", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const calls = [];
  const original = { ...row(), values: { title: "Original", notes: "Old" } };
  const newer = {
    ...original,
    values: { title: "Theirs", notes: "Remote" },
    eventId: "8".repeat(64),
  };
  let reject = true;
  const props = {
    schema: schema(),
    viewId: "table",
    onAddRow: async () => original,
    onSaveSchema: async () => schema(),
    onSaveRowValues: async (_id, values, baseEventId) => {
      calls.push({ values, baseEventId });
      if (reject) {
        reject = false;
        throw new Error("newer row");
      }
      return { ...newer, values, eventId: "9".repeat(64) };
    },
  };
  const view = render(
    React.createElement(DatabaseTableSurface, { ...props, rows: [original] }),
  );
  fireEvent.click(view.getByTestId(`database-cell-${ROW_ID}-title`));
  const input = view.getByLabelText("Edit Name");
  fireEvent.change(input, { target: { value: "Mine" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await view.findByRole("button", { name: "Retry Name" });
  view.rerender(
    React.createElement(DatabaseTableSurface, { ...props, rows: [newer] }),
  );
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent, /newer row was loaded/i),
  );
  fireEvent.click(view.getByRole("button", { name: "Retry Name" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], {
    values: { title: "Mine", notes: "Remote" },
    baseEventId: "8".repeat(64),
  });
});

test("a persisted prior definition restores select choices even when text accepts the raw id", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const changed = schema();
  changed.properties.push({
    id: "priority",
    name: "Priority",
    type: "text",
    priorDefinitions: [
      {
        type: "select",
        options: { choices: [{ id: "ready", name: "Ready" }] },
      },
    ],
  });
  changed.views[0].visiblePropertyIds.push("priority");
  const changedRow = {
    ...row(),
    values: { ...row().values, priority: "ready" },
  };
  const saved = [];
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: changed,
      rows: [changedRow],
      viewId: "table",
      onAddRow: async () => changedRow,
      onSaveSchema: async (content) => {
        saved.push(content);
        return { ...changed, ...content, eventId: "4".repeat(64) };
      },
      onSaveRowValues: async () => changedRow,
    }),
  );

  assert.doesNotMatch(
    view.getByTestId(`database-cell-${ROW_ID}-priority`).textContent,
    /type mismatch/i,
  );
  fireEvent.click(
    view.getByRole("button", { name: "Column settings for Priority" }),
  );
  fireEvent.click(
    await view.findByRole("button", { name: "Restore Priority as select" }),
  );
  await waitFor(() => assert.equal(saved.length, 1));
  const restored = saved[0].properties.find(
    (property) => property.id === "priority",
  );
  assert.equal(restored.type, "select");
  assert.deepEqual(restored.options.choices, [{ id: "ready", name: "Ready" }]);
});

test("a stale schema mutation rebases on the newest schema before Retry", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseConflictError } = await import(
    "../lib/useCommunityDatabases.ts"
  );
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const original = schema();
  const newest = {
    ...schema(),
    name: "Remote name",
    properties: schema().properties.map((property) =>
      property.id === "notes"
        ? { ...property, name: "Remote notes" }
        : property,
    ),
    eventId: "8".repeat(64),
  };
  const calls = [];
  let conflict = true;
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: original,
      rows: [row()],
      viewId: "table",
      onAddRow: async () => row(),
      onSaveSchema: async (content, baseEventId) => {
        calls.push({ content, baseEventId });
        if (conflict) {
          conflict = false;
          throw new DatabaseConflictError(newest);
        }
        return { ...newest, ...content, eventId: "9".repeat(64) };
      },
      onSaveRowValues: async () => row(),
    }),
  );

  fireEvent.click(
    view.getByRole("button", { name: "Column settings for Effort" }),
  );
  fireEvent.change(view.getByLabelText("Type for Effort"), {
    target: { value: "text" },
  });
  const retry = await view.findByRole("button", {
    name: "Retry database settings",
  });
  assert.equal(calls.length, 1);
  fireEvent.click(retry);
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].baseEventId, newest.eventId);
  assert.equal(calls[1].content.name, "Remote name");
  assert.equal(
    calls[1].content.properties.find((property) => property.id === "notes")
      .name,
    "Remote notes",
  );
  assert.equal(
    calls[1].content.properties.find((property) => property.id === "effort")
      .type,
    "text",
  );
});

test("a failed checkbox write keeps the attempted value visible and retryable", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const checkedSchema = schema();
  checkedSchema.properties.push({ id: "done", name: "Done", type: "checkbox" });
  checkedSchema.views[0].visiblePropertyIds.push("done");
  const checkedRow = {
    ...row(),
    values: { ...row().values, done: false },
  };
  const calls = [];
  let fail = true;
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: checkedSchema,
      rows: [checkedRow],
      viewId: "table",
      onAddRow: async () => checkedRow,
      onSaveSchema: async () => checkedSchema,
      onSaveRowValues: async (_id, values, baseEventId) => {
        calls.push({ values, baseEventId });
        if (fail) {
          fail = false;
          throw new Error("relay offline");
        }
        return { ...checkedRow, values, eventId: "3".repeat(64) };
      },
    }),
  );

  fireEvent.click(view.getByLabelText("Edit Done"));
  const retry = await view.findByRole("button", { name: "Retry Done" });
  assert.equal(view.getByLabelText("Edit Done").checked, true);
  assert.match(view.getByRole("alert").textContent, /relay offline/i);
  assert.deepEqual(calls[0], {
    values: { ...checkedRow.values, done: true },
    baseEventId: checkedRow.eventId,
  });
  fireEvent.click(retry);
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], calls[0]);
});

test("a Status column starts usable and persists labelled semantic choices", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseTableSurface } = await import("./DatabaseTableSurface.tsx");
  const saved = [];
  let accepted = schema();
  const view = render(
    React.createElement(DatabaseTableSurface, {
      schema: accepted,
      rows: [row()],
      viewId: "table",
      onAddRow: async () => row(),
      onSaveSchema: async (content) => {
        saved.push(content);
        accepted = {
          ...accepted,
          ...content,
          eventId: String(saved.length + 4).repeat(64),
        };
        return accepted;
      },
      onSaveRowValues: async () => row(),
    }),
  );
  fireEvent.click(view.getByRole("button", { name: /Property/ }));
  fireEvent.change(view.getByLabelText("Property name"), {
    target: { value: "Workflow" },
  });
  fireEvent.change(view.getByLabelText("Property type"), {
    target: { value: "status" },
  });
  fireEvent.click(view.getByRole("button", { name: "Add" }));
  await waitFor(() => assert.equal(saved.length, 1));
  const workflow = saved[0].properties.find(
    (property) => property.name === "Workflow",
  );
  assert.deepEqual(
    workflow.options.choices.map(({ name, group }) => ({ name, group })),
    [
      { name: "To do", group: "todo" },
      { name: "In progress", group: "doing" },
      { name: "Done", group: "done" },
    ],
  );
  fireEvent.click(
    view.getByRole("button", { name: "Column settings for Workflow" }),
  );
  const choices = view.getByLabelText("Status choices for Workflow");
  fireEvent.change(choices, {
    target: { value: "Backlog:todo, Active:doing, Done:done" },
  });
  fireEvent.blur(choices);
  await waitFor(() => assert.equal(saved.length, 2));
  assert.deepEqual(
    saved[1].properties
      .find((property) => property.name === "Workflow")
      .options.choices.map(({ name, group }) => ({ name, group })),
    [
      { name: "Backlog", group: "todo" },
      { name: "Active", group: "doing" },
      { name: "Done", group: "done" },
    ],
  );
});
