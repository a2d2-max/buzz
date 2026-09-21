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
    self: dom.window,
    window: dom.window,
  });
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
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

function schema() {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Work",
    properties: [
      { id: "title", name: "Name", type: "title" },
      {
        id: "effort",
        name: "Effort",
        type: "number",
        options: { format: "decimal" },
      },
      {
        id: "status",
        name: "Status",
        type: "status",
        options: {
          choices: [
            { id: "todo", name: "To do", group: "todo" },
            { id: "done", name: "Done", group: "done" },
          ],
        },
      },
      { id: "due", name: "Due", type: "date" },
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title", "effort", "status", "due"],
      },
      {
        id: "gallery",
        name: "Gallery",
        type: "gallery",
        sorts: [],
        visiblePropertyIds: ["title", "status"],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("friendly settings build nested filters, ordered sorts, and grouping in one typed mutation", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const mutations = [];
  const source = schema();
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      onApply: (mutation) => mutations.push(mutation),
      schema: source,
      view: source.views[0],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  assert.equal(screen.queryByRole("textbox", { name: /json/i }), null);
  assert.equal(screen.container.querySelector("textarea"), null);
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[0], {
    target: { value: "effort" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[0], {
    target: { value: "greater_than" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter value")[0], {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("Filter logic"), {
    target: { value: "or" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add filter group" }));
  assert.equal(screen.getAllByLabelText("Filter logic").length, 2);

  fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
  fireEvent.change(screen.getAllByLabelText("Sort property")[0], {
    target: { value: "status" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add sort" }));
  fireEvent.change(screen.getAllByLabelText("Sort property")[1], {
    target: { value: "effort" },
  });
  fireEvent.change(screen.getAllByLabelText("Sort direction")[1], {
    target: { value: "descending" },
  });
  fireEvent.change(screen.getByLabelText("Group property"), {
    target: { value: "status" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));

  assert.equal(mutations.length, 1);
  const next = mutations[0](source);
  assert.equal(next.views[0].filter.operator, "or");
  assert.equal(next.views[0].filter.filters[0].propertyId, "effort");
  assert.equal(next.views[0].filter.filters[0].value, 3);
  assert.equal(next.views[0].filter.filters[1].kind, "group");
  assert.deepEqual(next.views[0].sorts, [
    { propertyId: "status", direction: "ascending" },
    { propertyId: "effort", direction: "descending" },
  ]);
  assert.deepEqual(next.views[0].group, {
    propertyId: "status",
    direction: "ascending",
  });
  assert.equal(next.views[1], source.views[1]);
});

test("view tabs select without persistence and create a compatible saved view once", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewTabs } = await import("./DatabaseViewTabs.tsx");
  const selections = [];
  const mutations = [];
  const source = schema();
  const screen = render(
    React.createElement(DatabaseViewTabs, {
      disabled: false,
      onChange: (mutation) => mutations.push(mutation),
      onSelect: (id) => selections.push(id),
      schema: source,
      selectedViewId: "table",
    }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Gallery" }));
  assert.deepEqual(selections, ["gallery"]);
  assert.equal(mutations.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "New view" }));
  fireEvent.change(screen.getByLabelText("New view name"), {
    target: { value: "Sprint" },
  });
  fireEvent.change(screen.getByLabelText("New view type"), {
    target: { value: "board" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create view" }));
  assert.equal(mutations.length, 1);
  const next = mutations[0](source);
  assert.equal(next.views[2].name, "Sprint");
  assert.equal(next.views[2].type, "board");
  assert.equal(next.views[2].group.propertyId, "status");
});

test("switching tabs closes settings and resets the draft to the selected view", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const { DatabaseViewTabs } = await import("./DatabaseViewTabs.tsx");
  const source = schema();
  const mutations = [];

  function Harness() {
    const [selectedViewId, setSelectedViewId] = React.useState("table");
    const view = source.views.find(({ id }) => id === selectedViewId);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(DatabaseViewTabs, {
        disabled: false,
        onChange: () => {},
        onSelect: setSelectedViewId,
        schema: source,
        selectedViewId,
      }),
      React.createElement(DatabaseViewSettings, {
        disabled: false,
        onApply: (mutation) => mutations.push(mutation),
        schema: source,
        view,
      }),
    );
  }

  const screen = render(React.createElement(Harness));
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getByLabelText("Filter property"), {
    target: { value: "effort" },
  });
  fireEvent.change(screen.getByLabelText("Filter value"), {
    target: { value: "8" },
  });

  fireEvent.click(screen.getByRole("tab", { name: "Gallery" }));
  assert.equal(
    screen.queryByRole("button", { name: "Apply view settings" }),
    null,
    "a view switch must close the old view's settings draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));

  assert.equal(mutations.length, 1);
  const next = mutations[0](source);
  assert.equal(next.views[0].filter, undefined);
  assert.equal(next.views[1].filter, undefined);
  assert.deepEqual(next.views[1].sorts, []);
  assert.equal(next.views[1].group, undefined);
});

test("a newer accepted head for the same view keeps its open settings draft", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const source = schema();
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      onApply: () => {},
      schema: source,
      view: source.views[0],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getByLabelText("Filter property"), {
    target: { value: "effort" },
  });
  fireEvent.change(screen.getByLabelText("Filter value"), {
    target: { value: "8" },
  });
  const newer = {
    ...source,
    name: "Remote name",
    updatedAt: 2,
    views: source.views.map((view) => ({ ...view })),
  };
  screen.rerender(
    React.createElement(DatabaseViewSettings, {
      disabled: true,
      onApply: () => {},
      schema: newer,
      view: newer.views[0],
    }),
  );
  assert.ok(screen.getByRole("button", { name: "Apply view settings" }));
  assert.equal(screen.getByLabelText("Filter value").value, "8");
});

test("automatic time inputs persist timestamps that the production engine accepts", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const source = schema();
  source.properties.push(
    { id: "created", name: "Created", type: "created_time" },
    { id: "edited", name: "Edited", type: "last_edited_time" },
  );
  const mutations = [];
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      onApply: (mutation) => mutations.push(mutation),
      schema: source,
      view: source.views[0],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getByLabelText("Filter property"), {
    target: { value: "created" },
  });
  fireEvent.change(screen.getByLabelText("Filter operator"), {
    target: { value: "greater_than" },
  });
  fireEvent.change(screen.getByLabelText("Filter value"), {
    target: { value: "2026-09-09T10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[1], {
    target: { value: "edited" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[1], {
    target: { value: "less_than" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter value")[1], {
    target: { value: "2026-09-09T12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));

  const next = mutations[0](source);
  const lower = new Date("2026-09-09T10:00").getTime();
  const upper = new Date("2026-09-09T12:00").getTime();
  assert.equal(next.views[0].filter.filters[0].value, lower);
  assert.equal(next.views[0].filter.filters[1].value, upper);
  const result = resolveDatabaseView({
    schema: next,
    view: next.views[0],
    rows: [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        databaseId: source.id,
        values: { title: "Inside" },
        docPageId: null,
        createdAt: lower + 1,
        updatedAt: upper - 1,
        eventId: "a".repeat(64),
        eventCreatedAt: 1,
        author: "b".repeat(64),
      },
      {
        id: "bbbbbbbb-2222-4222-8222-222222222222",
        databaseId: source.id,
        values: { title: "Outside" },
        docPageId: null,
        createdAt: lower - 1,
        updatedAt: upper - 1,
        eventId: "c".repeat(64),
        eventCreatedAt: 1,
        author: "d".repeat(64),
      },
    ],
  });
  assert.deepEqual(
    result.rows.map(({ row }) => row.values.title),
    ["Inside"],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("array membership and timed date controls produce engine-valid filter shapes", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const source = schema();
  source.properties.push({
    id: "tags",
    name: "Tags",
    type: "multi_select",
    options: {
      choices: [
        { id: "ready", name: "Ready" },
        { id: "blocked", name: "Blocked" },
      ],
    },
  });
  source.properties.push({ id: "people", name: "People", type: "person" });
  const mutations = [];
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      onApply: (mutation) => mutations.push(mutation),
      schema: source,
      view: source.views[0],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.change(screen.getByLabelText("Filter property"), {
    target: { value: "tags" },
  });
  fireEvent.change(screen.getByLabelText("Filter value"), {
    target: { value: "blocked, ready" },
  });
  fireEvent.change(screen.getByLabelText("Filter operator"), {
    target: { value: "not_contains" },
  });
  assert.equal(screen.getByLabelText("Filter value").value, "blocked");

  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[1], {
    target: { value: "people" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter value")[1], {
    target: { value: "a".repeat(64) },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[1], {
    target: { value: "not_contains" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.change(screen.getAllByLabelText("Filter property")[2], {
    target: { value: "due" },
  });
  fireEvent.change(screen.getAllByLabelText("Filter operator")[2], {
    target: { value: "after" },
  });
  fireEvent.click(screen.getByLabelText("Include time in filter"));
  fireEvent.change(screen.getAllByLabelText("Filter value")[2], {
    target: { value: "2026-09-09T10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));

  const next = mutations[0](source);
  assert.equal(next.views[0].filter.filters[0].value, "blocked");
  assert.equal(next.views[0].filter.filters[1].value, "a".repeat(64));
  assert.equal(
    next.views[0].filter.filters[2].value,
    new Date("2026-09-09T10:00").toISOString(),
  );
  const makeRow = (id, values) => ({
    id,
    databaseId: source.id,
    values,
    docPageId: null,
    createdAt: 1,
    updatedAt: 1,
    eventId: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    eventCreatedAt: 1,
    author: "a".repeat(64),
  });
  const result = resolveDatabaseView({
    schema: next,
    view: next.views[0],
    rows: [
      makeRow("aaaaaaaa-1111-4111-8111-111111111111", {
        title: "Ready",
        tags: ["ready"],
        people: ["b".repeat(64)],
        due: {
          start: "2026-09-09T11:00:00Z",
          includeTime: true,
        },
      }),
      makeRow("bbbbbbbb-2222-4222-8222-222222222222", {
        title: "Blocked",
        tags: ["blocked"],
        people: ["b".repeat(64)],
        due: {
          start: "2026-09-09T11:00:00Z",
          includeTime: true,
        },
      }),
    ],
  });
  assert.deepEqual(
    result.rows.map(({ row }) => row.values.title),
    ["Ready"],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("dangling filter and group references reach friendly settings repair", async () => {
  const React = await import("react");
  const { fireEvent, render } = await import("@testing-library/react");
  const { parseDatabaseSchemaContent } = await import(
    "../lib/databaseSchemaCodec.ts"
  );
  const { resolveDatabaseView } = await import("../lib/databaseViewEngine.ts");
  const { DatabaseViewSettings } = await import("./DatabaseViewSettings.tsx");
  const { id, ...content } = schema();
  content.views[0] = {
    ...content.views[0],
    filter: {
      kind: "rule",
      propertyId: "removed-filter",
      operator: "equals",
      value: "old",
    },
    group: { propertyId: "removed-group", direction: "ascending" },
  };
  const parsed = parseDatabaseSchemaContent(content);
  assert.ok(parsed, "the signed schema must survive dangling view references");
  const source = { ...parsed, id };
  const before = resolveDatabaseView({
    schema: source,
    view: source.views[0],
    rows: [],
  });
  assert.equal(before.groupError, "unknown");
  assert.deepEqual(before.diagnostics, [
    { kind: "missing_property", propertyId: "removed-filter" },
  ]);

  const mutations = [];
  const screen = render(
    React.createElement(DatabaseViewSettings, {
      disabled: false,
      onApply: (mutation) => mutations.push(mutation),
      schema: source,
      view: source.views[0],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View settings" }));
  assert.ok(
    screen.getByRole("option", { name: /Missing property.*removed-filter/i }),
  );
  assert.ok(
    screen.getByRole("option", { name: /Missing property.*removed-group/i }),
  );
  fireEvent.change(screen.getByLabelText("Filter property"), {
    target: { value: "title" },
  });
  fireEvent.change(screen.getByLabelText("Group property"), {
    target: { value: "status" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply view settings" }));
  const repaired = mutations[0](source);
  const after = resolveDatabaseView({
    schema: repaired,
    view: repaired.views[0],
    rows: [],
  });
  assert.equal(after.groupError, null);
  assert.deepEqual(after.diagnostics, []);
});
