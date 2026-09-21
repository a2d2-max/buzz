import assert from "node:assert/strict";
import { before, after, afterEach, test } from "node:test";
import { installBoardTestDom } from "./communityTaskTestDom.mjs";
let dom;
before(() => {
  dom = installBoardTestDom();
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
});
after(() => dom.window.close());
test("shared definition is reused by stable identity and renamed without destroying its typed value", async () => {
  const React = await import("react");
  const { render, screen, fireEvent } = await import("@testing-library/react");
  const { CommunityTaskCustomFields } = await import(
    "./CommunityTaskCustomFields.tsx"
  );
  const owner = "a".repeat(64);
  let fields = [];
  const definition = {
    id: "estimate",
    key: owner + ":estimate",
    owner,
    name: "Estimate",
    type: "number",
    archived: false,
    event: {},
  };
  let definitions = [definition];
  let result;
  const element = () =>
    React.createElement(CommunityTaskCustomFields, {
      fields,
      definitions,
      onChange(value) {
        fields = value;
        result.rerender(element());
      },
    });
  result = render(element());
  fireEvent.change(screen.getByRole("combobox", { name: "Add shared field" }), {
    target: { value: definition.key },
  });
  assert.equal(fields[0].id, owner + ":estimate");
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Value: Estimate" }),
    { target: { value: "2.5" } },
  );
  assert.equal(fields[0].value, 2.5);
  assert.equal(
    screen.getByRole("textbox", { name: "Field name: Estimate" }).disabled,
    true,
  );
  definitions = [{ ...definition, name: "Points" }];
  result.rerender(element());
  assert.equal(
    screen.getByRole("spinbutton", { name: "Value: Points" }).value,
    "2.5",
  );
  definitions = [{ ...definition, archived: true }];
  result.rerender(element());
  assert.equal(
    screen.getByRole("spinbutton", { name: "Value: Estimate" }).value,
    "2.5",
  );
  assert.ok(!screen.queryByRole("combobox", { name: "Add shared field" }));
});
test("read-only task viewers cannot add, clear or remove shared values", async () => {
  const React = await import("react");
  const { render, screen } = await import("@testing-library/react");
  const { CommunityTaskCustomFields } = await import(
    "./CommunityTaskCustomFields.tsx"
  );
  render(
    React.createElement(CommunityTaskCustomFields, {
      readonly: true,
      fields: [{ id: "x", name: "Flag", type: "checkbox", value: false }],
      onChange() {
        throw Error("read-only mutation");
      },
    }),
  );
  assert.match(screen.getByText(/Flag:/).textContent, /Unchecked/);
  assert.ok(!screen.queryByRole("button", { name: /Remove|Clear|Add/ }));
});
