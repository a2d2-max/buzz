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
        ["Element", "Node", "Event", "MouseEvent"].includes(key))
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

const SOURCE = "11111111-2222-4333-8444-555555555555";
const TARGET = "22222222-3333-4444-8555-666666666666";

function schema(id, eventId = "1".repeat(64), extra = []) {
  return {
    id,
    name: id === SOURCE ? "Projects" : "Scores",
    properties: [
      { id: "title", name: "Name", type: "title" },
      ...(id === SOURCE
        ? [
            {
              id: "effort",
              name: "Effort",
              type: "number",
              options: { format: "decimal" },
            },
          ]
        : []),
      ...extra,
    ],
    views: [
      {
        id: "table",
        name: "Table",
        type: "table",
        sorts: [],
        visiblePropertyIds: ["title"],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    author: "a".repeat(64),
    eventId,
    eventCreatedAt: 1,
    eventKind: 30624,
    deleted: false,
  };
}

test("relation pairing is exactly two explicit schema actions with planned reciprocal ids", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const source = schema(SOURCE);
  const target = schema(TARGET, "2".repeat(64));
  const schemas = new Map([
    [SOURCE, source],
    [TARGET, target],
  ]);
  const calls = [];
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas,
      lookupSchema: async (id) => schemas.get(id),
      onSaveSchema: async (id, content, baseEventId) => {
        calls.push({ id, content, baseEventId });
        return {
          ...schemas.get(id),
          ...content,
          eventId: `${calls.length + 2}`.repeat(64),
        };
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.change(view.getByLabelText("Related database"), {
    target: { value: TARGET },
  });
  fireEvent.change(view.getByLabelText("relation property name"), {
    target: { value: "Scores" },
  });
  fireEvent.change(view.getByLabelText("Reciprocal property name"), {
    target: { value: "Projects" },
  });
  fireEvent.click(
    view.getByRole("button", { name: "1. Save source relation" }),
  );
  const secondAction = await view.findByRole("button", {
    name: "2. Create reciprocal property",
  });
  assert.equal(calls.length, 1);
  const owner = calls[0].content.properties.at(-1);
  assert.equal(calls[0].id, SOURCE);
  assert.equal(owner.options.direction, "authoritative");
  assert.ok(owner.options.mirroredPropertyId);

  fireEvent.click(secondAction);
  await waitFor(() => assert.equal(calls.length, 2));
  const mirror = calls[1].content.properties.at(-1);
  assert.equal(calls[1].id, TARGET);
  assert.deepEqual(mirror.options, {
    databaseId: SOURCE,
    direction: "mirror",
    mirroredPropertyId: owner.id,
  });
  assert.equal(owner.options.mirroredPropertyId, mirror.id);
});

test("obvious formula errors keep their draft without a schema event while numeric formulas save on an empty database", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const source = schema(SOURCE);
  const calls = [];
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas: new Map([[SOURCE, source]]),
      lookupSchema: async () => source,
      onSaveSchema: async (_id, content) => {
        calls.push(content);
        return { ...source, ...content, eventId: "3".repeat(64) };
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.click(view.getByRole("button", { name: "Formula" }));
  const expression = view.getByLabelText("Formula expression");
  fireEvent.change(expression, { target: { value: 'prop("Name") * 2' } });
  fireEvent.click(view.getByRole("button", { name: "Save formula" }));
  assert.equal(calls.length, 0);
  assert.match(view.getByRole("status").textContent, /TYPE_MISMATCH/u);
  assert.equal(expression.value, 'prop("Name") * 2');

  fireEvent.change(expression, { target: { value: 'prop("Effort") * 2' } });
  fireEvent.click(view.getByRole("button", { name: "Save formula" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(
    calls[0].properties.at(-1).options.expression,
    'prop("Effort") * 2',
  );
});

test("schema conflict retry reapplies the planned relation to the newest unrelated fields", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const { DatabaseConflictError } = await import(
    "../lib/useCommunityDatabases.ts"
  );
  const source = schema(SOURCE);
  const target = schema(TARGET, "2".repeat(64));
  const newest = schema(SOURCE, "9".repeat(64), [
    { id: "remote", name: "Remote", type: "text" },
  ]);
  const calls = [];
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas: new Map([
        [SOURCE, source],
        [TARGET, target],
      ]),
      lookupSchema: async (id) => (id === SOURCE ? source : target),
      onSaveSchema: async (id, content, baseEventId) => {
        calls.push({ id, content, baseEventId });
        if (calls.length === 1) throw new DatabaseConflictError(newest);
        return { ...newest, ...content, eventId: "a".repeat(64) };
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.change(view.getByLabelText("Related database"), {
    target: { value: TARGET },
  });
  fireEvent.click(
    view.getByRole("button", { name: "1. Save source relation" }),
  );
  await waitFor(() =>
    view.getByRole("button", { name: "Retry computed property" }),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Retry computed property" }),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].baseEventId, newest.eventId);
  assert.equal(
    calls[1].content.properties.some(({ id }) => id === "remote"),
    true,
  );
  assert.equal(
    calls[1].content.properties.some(
      (property) =>
        property.type === "relation" &&
        property.options.direction === "authoritative",
    ),
    true,
  );
});

test("formula retry revalidates meaning against newest schema and keeps an ambiguous draft without writing", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const { DatabaseConflictError } = await import(
    "../lib/useCommunityDatabases.ts"
  );
  const source = schema(SOURCE);
  const newest = schema(SOURCE, "9".repeat(64), [
    {
      id: "other_effort",
      name: "Effort",
      type: "number",
      options: { format: "decimal" },
    },
  ]);
  const calls = [];
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas: new Map([[SOURCE, source]]),
      lookupSchema: async () => newest,
      onSaveSchema: async (...args) => {
        calls.push(args);
        throw new DatabaseConflictError(newest);
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.click(view.getByRole("button", { name: "Formula" }));
  fireEvent.change(view.getByLabelText("Formula expression"), {
    target: { value: 'prop("Effort") * 2' },
  });
  fireEvent.click(view.getByRole("button", { name: "Save formula" }));
  await view.findByRole("button", { name: "Retry computed property" });
  fireEvent.click(
    view.getByRole("button", { name: "Retry computed property" }),
  );
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent, /AMBIGUOUS_PROPERTY/u),
  );
  assert.equal(calls.length, 1);
  assert.equal(
    view.getByLabelText("Formula expression").value,
    'prop("Effort") * 2',
  );
});

test("retry rebases onto a later live head than the conflict and keeps unrelated fields", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const { DatabaseConflictError } = await import(
    "../lib/useCommunityDatabases.ts"
  );
  const source = schema(SOURCE);
  const target = schema(TARGET, "2".repeat(64));
  const conflict = schema(SOURCE, "8".repeat(64), [
    { id: "remote_one", name: "Remote one", type: "text" },
  ]);
  const live = schema(SOURCE, "9".repeat(64), [
    { id: "remote_two", name: "Remote two", type: "text" },
  ]);
  const calls = [];
  const props = {
    schema: source,
    schemas: new Map([
      [SOURCE, source],
      [TARGET, target],
    ]),
    lookupSchema: async (id) => (id === SOURCE ? live : target),
    onSaveSchema: async (id, content, baseEventId) => {
      calls.push({ id, content, baseEventId });
      if (calls.length === 1) throw new DatabaseConflictError(conflict);
      return { ...live, ...content, eventId: "a".repeat(64) };
    },
  };
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, props),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.change(view.getByLabelText("Related database"), {
    target: { value: TARGET },
  });
  fireEvent.click(
    view.getByRole("button", { name: "1. Save source relation" }),
  );
  await view.findByRole("button", { name: "Retry computed property" });
  view.rerender(
    React.createElement(DatabaseComputedPropertyPanel, {
      ...props,
      schema: live,
      schemas: new Map([
        [SOURCE, live],
        [TARGET, target],
      ]),
    }),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Retry computed property" }),
  );
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].baseEventId, live.eventId);
  assert.equal(
    calls[1].content.properties.some(({ id }) => id === "remote_two"),
    true,
  );
});

test("an incomplete reciprocal step looks up its missing target and keeps a retryable failure", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const target = schema(TARGET, "2".repeat(64));
  const source = schema(SOURCE, "1".repeat(64), [
    {
      id: "relation_existing",
      name: "Scores",
      type: "relation",
      options: {
        databaseId: TARGET,
        direction: "authoritative",
        mirroredPropertyId: "relation_mirror_planned",
      },
    },
  ]);
  let lookups = 0;
  const calls = [];
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas: new Map([[SOURCE, source]]),
      lookupSchema: async () => (++lookups === 1 ? undefined : target),
      onSaveSchema: async (...args) => {
        calls.push(args);
        return target;
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  const reciprocal = await view.findByRole("button", {
    name: "2. Create reciprocal property",
  });
  fireEvent.click(reciprocal);
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent, /unavailable/u),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Retry computed property" }),
  );
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0][0], TARGET);
  assert.equal(calls[0][1].properties.at(-1).id, "relation_mirror_planned");
});

test("rollup retry validates the current target type before another schema write", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const relation = {
    id: "scores_relation",
    name: "Scores",
    type: "relation",
    options: { databaseId: TARGET, direction: "authoritative" },
  };
  const rollup = {
    id: "score_total",
    name: "Score total",
    type: "rollup",
    options: {
      relationPropertyId: relation.id,
      targetPropertyId: "score",
      calculation: "sum",
      resultType: "number",
    },
  };
  const source = schema(SOURCE, "1".repeat(64), [relation, rollup]);
  const numericTarget = schema(TARGET, "2".repeat(64), [
    {
      id: "score",
      name: "Score",
      type: "number",
      options: { format: "decimal" },
    },
  ]);
  const textTarget = schema(TARGET, "9".repeat(64), [
    { id: "score", name: "Score", type: "text" },
  ]);
  const calls = [];
  const props = {
    schema: source,
    schemas: new Map([
      [SOURCE, source],
      [TARGET, numericTarget],
    ]),
    lookupSchema: async () => textTarget,
    onSaveSchema: async (...args) => {
      calls.push(args);
      throw new Error("offline");
    },
  };
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, props),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.change(view.getByLabelText("Computed property to configure"), {
    target: { value: rollup.id },
  });
  fireEvent.click(view.getByRole("button", { name: "Update rollup" }));
  await view.findByRole("button", { name: "Retry computed property" });
  view.rerender(
    React.createElement(DatabaseComputedPropertyPanel, {
      ...props,
      schemas: new Map([
        [SOURCE, source],
        [TARGET, textTarget],
      ]),
    }),
  );
  fireEvent.click(
    view.getByRole("button", { name: "Retry computed property" }),
  );
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent, /requires numeric/u),
  );
  assert.equal(calls.length, 1);
});

test("changing a computed mode archives the full prior definition in the one schema snapshot", async () => {
  const React = await import("react");
  const { fireEvent, render, waitFor } = await import("@testing-library/react");
  const { DatabaseComputedPropertyPanel } = await import(
    "./DatabaseComputedPropertyPanel.tsx"
  );
  const relation = {
    id: "scores_relation",
    name: "Scores",
    type: "relation",
    options: { databaseId: TARGET, direction: "authoritative" },
  };
  const formula = {
    id: "computed",
    name: "Computed",
    type: "formula",
    options: { expression: 'prop("Effort") * 2', resultType: "number" },
  };
  const source = schema(SOURCE, "1".repeat(64), [relation, formula]);
  const target = schema(TARGET, "2".repeat(64), [
    {
      id: "score",
      name: "Score",
      type: "number",
      options: { format: "decimal" },
    },
  ]);
  const calls = [];
  const schemas = new Map([
    [SOURCE, source],
    [TARGET, target],
  ]);
  const view = render(
    React.createElement(DatabaseComputedPropertyPanel, {
      schema: source,
      schemas,
      lookupSchema: async (id) => schemas.get(id),
      onSaveSchema: async (_id, content) => {
        calls.push(content);
        return { ...source, ...content, eventId: "3".repeat(64) };
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Computed property" }));
  fireEvent.change(view.getByLabelText("Computed property to configure"), {
    target: { value: formula.id },
  });
  fireEvent.click(view.getByRole("button", { name: "Rollup" }));
  fireEvent.change(view.getByLabelText("Rollup relation"), {
    target: { value: relation.id },
  });
  fireEvent.change(view.getByLabelText("Rollup target property"), {
    target: { value: "score" },
  });
  fireEvent.change(view.getByLabelText("Rollup calculation"), {
    target: { value: "sum" },
  });
  fireEvent.click(view.getByRole("button", { name: "Update rollup" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const changed = calls[0].properties.find(({ id }) => id === formula.id);
  assert.equal(changed.type, "rollup");
  assert.deepEqual(changed.priorDefinitions, [
    {
      type: "formula",
      options: { expression: 'prop("Effort") * 2', resultType: "number" },
    },
  ]);
});
