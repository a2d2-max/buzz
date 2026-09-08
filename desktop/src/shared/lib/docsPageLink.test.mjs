/**
 * Golden forms for the Docs page link. Pages imported from other tools link
 * to each other with `/#/docs/<pageId>` — the app's own hash-route URL — so
 * the parser must accept every relative spelling of that route and nothing
 * that merely looks like it on another host.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDocsPageLink,
  DOC_PAGE_ID_PATTERN,
  parseDocsPageLink,
} from "./docsPageLink.ts";

const APP_ORIGIN = "http://localhost";

test("builds the hash-route form the app itself navigates to", () => {
  assert.equal(buildDocsPageLink("3f0c2b1a-7d4e"), "/#/docs/3f0c2b1a-7d4e");
});

test("refuses to build a link for an id the page codec would reject", () => {
  assert.throws(() => buildDocsPageLink("bad id"), /page id/);
  assert.throws(() => buildDocsPageLink(""), /page id/);
});

test("the id rule is the codec's rule: one leading alphanumeric, then up to 127 of [A-Za-z0-9_-]", () => {
  assert.ok(DOC_PAGE_ID_PATTERN.test("a"));
  assert.ok(DOC_PAGE_ID_PATTERN.test(`a${"-".repeat(127)}`));
  assert.ok(!DOC_PAGE_ID_PATTERN.test(`a${"-".repeat(128)}`));
  assert.ok(!DOC_PAGE_ID_PATTERN.test("-leading-dash"));
  assert.ok(!DOC_PAGE_ID_PATTERN.test("with space"));
});

test("parses every relative spelling of the route, and the app's own absolute URL", () => {
  for (const href of [
    "/#/docs/abc-123",
    "#/docs/abc-123",
    "./#/docs/abc-123",
    "/#/docs/abc-123/",
    "http://localhost/#/docs/abc-123",
    "http://localhost/index.html#/docs/abc-123",
  ]) {
    assert.deepEqual(
      parseDocsPageLink(href, APP_ORIGIN),
      { ok: true, value: { pageId: "abc-123" } },
      href,
    );
  }
});

test("leaves other hosts, other routes, extra segments and malformed ids to the external handler", () => {
  for (const href of [
    "https://example.com/#/docs/abc-123",
    "http://localhost:1420/#/docs/abc-123",
    "/#/channels/abc-123",
    "/#/docs",
    "/#/docs/",
    "/#/docs/abc-123/child",
    "/#/docs/abc-123?x=1",
    "/#/docs/bad%20id",
    "/#/docs/-dash",
    "/docs/abc-123",
    "#user-content-fn-1",
    "#",
    "",
    "mailto:someone@example.com",
    "buzz://channel/3f0c2b1a-7d4e-4c9a-9b1e-2a6f8d5c4e10",
  ]) {
    assert.equal(parseDocsPageLink(href, APP_ORIGIN).ok, false, href);
  }
});

test("without a known app origin, only the relative spellings count", () => {
  assert.equal(parseDocsPageLink("/#/docs/abc", undefined).ok, true);
  assert.equal(
    parseDocsPageLink("http://localhost/#/docs/abc", undefined).ok,
    false,
  );
});
