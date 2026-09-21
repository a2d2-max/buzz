import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        [
          "Element",
          "Node",
          "Event",
          "MouseEvent",
          "KeyboardEvent",
          "FocusEvent",
        ].includes(key))
    ) {
      if (dom.window[key] !== undefined) globalThis[key] = dom.window[key];
    }
  }
});
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
after(() => dom.window.close());

const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const properties = {
  title: { id: "title", name: "Name", type: "title" },
  status: {
    id: "status",
    name: "Status",
    type: "select",
    options: { choices: [{ id: "ready", name: "Ready" }] },
  },
  due: { id: "due", name: "Due", type: "date" },
};
function row(id, values) {
  return {
    id,
    databaseId: DATABASE_ID,
    values,
    docPageId: null,
    createdBy: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    author: "b".repeat(64),
    eventId: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    eventCreatedAt: 1,
    eventKind: 30625,
    deleted: false,
  };
}
const scheduled = row("aaaaaaaa-1111-4111-8111-111111111111", {
  title: "Launch",
  status: "ready",
  due: { start: "2026-09-09", end: "2026-09-10", includeTime: false },
});
const missing = row("bbbbbbbb-2222-4222-8222-222222222222", {
  title: "Missing",
  status: null,
  due: null,
});
function resolved(candidate) {
  return { row: candidate, values: new Map(Object.entries(candidate.values)) };
}

test("calendar renders inclusive ranges and recovers a missing date with one full-row save", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseCalendarSurface } = await import(
    "./DatabaseCalendarSurface.tsx"
  );
  const calls = [];
  const screen = render(
    React.createElement(DatabaseCalendarSurface, {
      dateProperty: properties.due,
      rows: [resolved(scheduled), resolved(missing)],
      titleProperty: properties.title,
      onSaveRowValues: async (rowId, values, baseEventId) => {
        calls.push({ rowId, values, baseEventId });
        return { ...missing, values, eventId: "9".repeat(64) };
      },
    }),
  );
  assert.ok(screen.getByText("Needs date"));
  assert.ok(screen.getByText("Launch"));
  fireEvent.click(screen.getByRole("button", { name: "Set date for Missing" }));
  fireEvent.change(screen.getByLabelText("Date for Missing"), {
    target: { value: "2026-09-12" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save date for Missing" }),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], {
    rowId: missing.id,
    values: {
      title: "Missing",
      status: null,
      due: { start: "2026-09-12", includeTime: false },
    },
    baseEventId: missing.eventId,
  });
});

test("calendar date retry rebases its typed draft and rejects a backwards range", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseCalendarSurface } = await import(
    "./DatabaseCalendarSurface.tsx"
  );
  const stale = {
    ...missing,
    values: { ...missing.values, note: "old" },
    eventId: "1".repeat(64),
  };
  const remote = {
    ...stale,
    values: { ...stale.values, note: "remote", status: "ready" },
    eventId: "2".repeat(64),
  };
  const calls = [];
  const onSaveRowValues = async (rowId, values, baseEventId) => {
    calls.push({ rowId, values, baseEventId });
    if (calls.length === 1) throw new Error("relay rejected");
    return { ...remote, values, eventId: "3".repeat(64) };
  };
  const screen = render(
    React.createElement(DatabaseCalendarSurface, {
      dateProperty: properties.due,
      rows: [resolved(stale)],
      titleProperty: properties.title,
      onSaveRowValues,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Set date for Missing" }));
  fireEvent.change(screen.getByLabelText("Date for Missing"), {
    target: { value: "2026-09-12" },
  });
  fireEvent.change(screen.getByLabelText("End date for Missing"), {
    target: { value: "2026-09-11" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save date for Missing" }),
  );
  assert.equal(calls.length, 0);
  assert.match(screen.getByRole("alert").textContent, /before the start/i);

  fireEvent.change(screen.getByLabelText("End date for Missing"), {
    target: { value: "2026-09-13" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save date for Missing" }),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.match(screen.getByRole("alert").textContent, /relay rejected/i);

  screen.rerender(
    React.createElement(DatabaseCalendarSurface, {
      dateProperty: properties.due,
      rows: [resolved(remote)],
      titleProperty: properties.title,
      onSaveRowValues,
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry date for Missing" }),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], {
    rowId: remote.id,
    values: {
      ...remote.values,
      due: {
        start: "2026-09-12",
        end: "2026-09-13",
        includeTime: false,
      },
    },
    baseEventId: remote.eventId,
  });
});

test("gallery and grouped table use the same resolved rows with honest visible values", async () => {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { DatabaseGallerySurface } = await import(
    "./DatabaseGallerySurface.tsx"
  );
  const { DatabaseGroupedTableSurface } = await import(
    "./DatabaseGroupedTableSurface.tsx"
  );
  const rows = [resolved(scheduled), resolved(missing)];
  const gallery = render(
    React.createElement(DatabaseGallerySurface, {
      properties: [properties.title, properties.status],
      rows,
      titleProperty: properties.title,
    }),
  );
  assert.ok(gallery.getByRole("article", { name: "Launch" }));
  assert.match(
    gallery.getByRole("article", { name: "Launch" }).textContent,
    /StatusReady/,
  );
  gallery.unmount();
  const saves = [];
  const grouped = render(
    React.createElement(DatabaseGroupedTableSurface, {
      groups: [
        {
          key: "ready",
          label: "Ready",
          value: "ready",
          rows: [resolved(scheduled)],
          empty: false,
        },
        {
          key: "empty",
          label: "Empty",
          value: null,
          rows: [resolved(missing)],
          empty: true,
        },
      ],
      onRestoreType: async () => {},
      onSaveRowValues: async (rowId, values, baseEventId) => {
        saves.push({ rowId, values, baseEventId });
        return { ...scheduled, values, eventId: "9".repeat(64) };
      },
      properties: [properties.title, properties.status],
    }),
  );
  assert.ok(grouped.getByRole("region", { name: "Ready group" }));
  assert.ok(grouped.getByRole("region", { name: "Empty group" }));
  assert.equal(grouped.getAllByRole("gridcell").length, 4);
  const { fireEvent, waitFor } = await import("@testing-library/react");
  fireEvent.click(grouped.getAllByRole("button", { name: "Edit Name" })[0]);
  const nameInput = grouped.container.querySelector(
    'input[aria-label="Edit Name"]',
  );
  fireEvent.change(nameInput, { target: { value: "Edited" } });
  fireEvent.keyDown(nameInput, { key: "Enter" });
  await waitFor(() => assert.equal(saves.length, 1));
  assert.deepEqual(saves[0].values, { ...scheduled.values, title: "Edited" });
});
