import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { applyRaouDocumentTheme, RAOU_THEME } from "./raouDocumentTheme.ts";

test("RAOU owns a forced-dark document palette inherited by body portals", () => {
  const dom = new JSDOM(
    '<!doctype html><html class="light"><body><div id="portal"></div></body></html>',
  );

  applyRaouDocumentTheme(dom.window.document);

  const root = dom.window.document.documentElement;
  const portal = dom.window.document.getElementById("portal");
  assert.equal(root.classList.contains("light"), false);
  assert.equal(root.classList.contains("dark"), true);
  assert.equal(root.dataset.raouPrimary, "true");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(
    root.style.getPropertyValue("--background"),
    RAOU_THEME["--background"],
  );
  assert.equal(
    portal.ownerDocument.documentElement.style.getPropertyValue("--background"),
    RAOU_THEME["--background"],
  );
});
