import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/#/ops?view=room",
});
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  window: dom.window,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const { OpsArtifactError } = await import("../opsBridge.ts");
const { OpsArtifactReader } = await import("./OpsArtifactReader.tsx");

const SELECTION = {
  id: "artifact:0123456789abcdef0123456789abcdef",
  title: "Parity report",
  kind: "markdown",
  status: "ready",
  version: 1,
  representation: "preview",
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function renderReader(loader, selection = SELECTION) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const trigger = document.createElement("button");
  trigger.textContent = "Open artifact";
  document.body.append(trigger);
  trigger.focus();
  let open = true;
  const renderElement = (artifact, loadArtifact) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(OpsArtifactReader, {
        artifact,
        loadArtifact,
        onClose() {
          open = false;
          view.rerender(
            React.createElement(QueryClientProvider, { client }, null),
          );
        },
        returnFocus: trigger,
      }),
    );
  const view = render(renderElement(selection, loader));
  return {
    isOpen: () => open,
    rerenderReader(nextSelection, nextLoader) {
      view.rerender(renderElement(nextSelection, nextLoader));
    },
    trigger,
    unmount: view.unmount,
  };
}

describe("OpsArtifactReader", () => {
  test("shows loading, focuses the dialog, renders inline text, and restores focus on Escape", async () => {
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const { isOpen, trigger } = renderReader(() => pending);
    const dialog = screen.getByRole("dialog", { name: "Parity report" });
    assert.equal(document.activeElement, dialog);
    assert.ok(screen.getByRole("status").textContent.includes("불러오는 중"));

    resolve({
      mime: "text/markdown",
      source: "inline",
      text: "# Immutable report",
      totalSize: 18,
    });
    await screen.findByText("# Immutable report");
    assert.ok(
      screen
        .getByTestId("ops-artifact-verification")
        .textContent.includes("인라인 검증됨"),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, trigger);
  });

  for (const [code, copy] of [
    ["artifact_read_denied", "권한"],
    ["artifact_integrity_mismatch", "무결성"],
    ["artifact_version_not_found", "버전"],
    ["artifact_too_large", "너무 큽니다"],
    ["artifact_media_unsupported", "지원하지 않는 형식"],
  ]) {
    test(`renders the explicit ${code} state`, async () => {
      renderReader(async () => {
        throw new OpsArtifactError(code);
      });
      await waitFor(() =>
        assert.ok(screen.getByRole("alert").textContent.includes(copy)),
      );
    });
  }

  test("keeps the reader bounded and never exposes the opaque handle", async () => {
    renderReader(async () => ({
      mime: "text/plain",
      source: "inline",
      text: "streamed body",
      totalSize: 13,
    }));
    const dialog = screen.getByRole("dialog", { name: "Parity report" });
    await screen.findByText("streamed body");
    assert.equal(dialog.getAttribute("data-bounded"), "true");
    assert.equal(dialog.textContent.includes("artifact-handle:"), false);
    assert.equal(dialog.getAttribute("aria-label"), "Parity report");
  });

  test("keeps an opaque object URL private and revokes it exactly once on close", async () => {
    const created = [];
    const revoked = [];
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      created.push(blob);
      return "blob:private-artifact";
    };
    URL.revokeObjectURL = (url) => revoked.push(url);

    try {
      const { isOpen } = renderReader(async () => ({
        blob: new Blob(["streamed body"], { type: "text/plain" }),
        mime: "text/plain",
        source: "opaque",
        text: "streamed body",
        totalSize: 13,
      }));
      await screen.findByText("streamed body");
      const dialog = screen.getByRole("dialog", { name: "Parity report" });
      await waitFor(() => assert.equal(created.length, 1));
      assert.ok(
        screen
          .getByTestId("ops-artifact-verification")
          .textContent.includes("보안 스트림 검증됨"),
      );
      assert.equal(dialog.textContent.includes("blob:private-artifact"), false);
      fireEvent.keyDown(dialog, { key: "Escape" });
      assert.equal(isOpen(), false);
      assert.deepEqual(revoked, ["blob:private-artifact"]);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  test("revokes private object URLs on artifact replacement and load error", async () => {
    const created = [];
    const revoked = [];
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const value = `blob:private-${created.length + 1}`;
      created.push(value);
      return value;
    };
    URL.revokeObjectURL = (url) => revoked.push(url);

    try {
      const firstContent = {
        blob: new Blob(["first"], { type: "text/plain" }),
        mime: "text/plain",
        source: "opaque",
        text: "first private body",
        totalSize: 5,
      };
      const secondContent = {
        blob: new Blob(["second"], { type: "text/plain" }),
        mime: "text/plain",
        source: "opaque",
        text: "second private body",
        totalSize: 6,
      };
      const view = renderReader(async () => firstContent);
      await screen.findByText("first private body");
      await waitFor(() => assert.equal(created.length, 1));

      view.rerenderReader(
        { ...SELECTION, version: 2 },
        async () => secondContent,
      );
      await screen.findByText("second private body");
      await waitFor(() => {
        assert.equal(created.length, 2);
        assert.deepEqual(revoked, ["blob:private-1"]);
      });

      view.rerenderReader({ ...SELECTION, version: 3 }, async () => {
        throw new OpsArtifactError("artifact_media_unsupported");
      });
      await screen.findByRole("alert");
      await waitFor(() =>
        assert.deepEqual(revoked, ["blob:private-1", "blob:private-2"]),
      );
      view.unmount();
      assert.deepEqual(revoked, ["blob:private-1", "blob:private-2"]);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  test("wraps focus in both directions and recaptures displaced focus", async () => {
    const { trigger } = renderReader(async () => {
      throw new OpsArtifactError("artifact_read_denied");
    });
    await waitFor(() => assert.ok(screen.getByRole("alert")));
    const dialog = screen.getByRole("dialog", { name: "Parity report" });
    const close = screen.getByRole("button", { name: "아티팩트 닫기" });
    const retry = screen.getByRole("button", { name: "다시 시도" });

    fireEvent.keyDown(dialog, { key: "Tab" });
    assert.equal(document.activeElement === close, true);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement === retry, true);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement === retry, true);
    fireEvent.keyDown(retry, { key: "Tab" });
    assert.equal(document.activeElement === close, true);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement === retry, true);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Tab" });
    assert.equal(document.activeElement === close, true);
  });
});
