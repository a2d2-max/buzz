import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { cleanup, fireEvent, render, screen } = await import(
  "@testing-library/react"
);
const { OpsSecondaryNav } = await import("./OpsSecondaryNav.tsx");

afterEach(cleanup);

test("opens the mobile Sections sheet and returns focus to its trigger after selection", () => {
  let selected = null;
  render(
    React.createElement(OpsSecondaryNav, {
      layout: "mobile",
      onSelect(view) {
        selected = view;
      },
      view: "room",
    }),
  );

  const trigger = screen.getByRole("button", { name: "Sections" });
  trigger.focus();
  fireEvent.click(trigger);
  assert.ok(
    document.activeElement === screen.getByRole("dialog", { name: "Sections" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Artifacts" }));
  assert.equal(selected, "artifacts");
  assert.ok(document.activeElement === trigger);
});

test("recaptures focus when a mobile Sections dialog loses focus outside itself", () => {
  render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { type: "button" }, "Outside"),
      React.createElement(OpsSecondaryNav, {
        layout: "mobile",
        onSelect() {},
        view: "room",
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sections" }));
  const dialog = screen.getByRole("dialog", { name: "Sections" });
  const outside = screen.getByRole("button", { name: "Outside" });
  outside.focus();
  fireEvent.focusIn(outside);
  assert.ok(document.activeElement === dialog);
});

test("cycles mobile Sections focus in both Tab directions and closes on Escape", () => {
  render(
    React.createElement(OpsSecondaryNav, {
      layout: "mobile",
      onSelect() {},
      view: "room",
    }),
  );
  const trigger = screen.getByRole("button", { name: "Sections" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Sections" });
  const buttons = Array.from(dialog.querySelectorAll("button:not([disabled])"));
  buttons.at(-1).focus();
  fireEvent.keyDown(buttons.at(-1), { key: "Tab" });
  assert.ok(document.activeElement === buttons[0]);
  buttons[0].focus();
  fireEvent.keyDown(buttons[0], { key: "Tab", shiftKey: true });
  assert.ok(document.activeElement === buttons.at(-1));
  fireEvent.keyDown(dialog, { key: "Escape" });
  assert.ok(screen.queryByRole("dialog", { name: "Sections" }) === null);
  assert.ok(document.activeElement === trigger);
});

test("opens authenticated native screens and disables them for a guest", () => {
  const opened = [];
  const authenticated = render(
    React.createElement(OpsSecondaryNav, {
      layout: "desktop",
      onOpenAgents: () => opened.push("agents"),
      onOpenProjects: () => opened.push("projects"),
      onOpenSettings: () => opened.push("settings"),
      onOpenWorkflows: () => opened.push("workflows"),
      onSelect() {},
      view: "room",
    }),
  );
  for (const label of ["Agents", "Projects", "Workflows", "Settings"])
    fireEvent.click(screen.getByRole("button", { name: label }));
  assert.deepEqual(opened, ["agents", "projects", "workflows", "settings"]);
  authenticated.unmount();

  render(
    React.createElement(OpsSecondaryNav, {
      layout: "desktop",
      onSelect() {},
      view: "room",
    }),
  );
  for (const label of ["Agents", "Projects", "Workflows", "Settings"])
    assert.equal(screen.getByRole("button", { name: label }).disabled, true);
});
