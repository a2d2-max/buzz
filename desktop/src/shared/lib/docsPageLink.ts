/**
 * Links to Docs pages.
 *
 * The desktop router uses hash history, so a page's URL is
 * `<app origin>/#/docs/<pageId>` and the portable spelling — the one pages
 * imported from other tools carry in their bodies — is `/#/docs/<pageId>`.
 * `parseDocsPageLink` accepts every relative spelling of that route plus the
 * app's own absolute URL. A look-alike on another host is somebody else's
 * site and stays an external link.
 */

/** One leading alphanumeric, then up to 127 of `[A-Za-z0-9_-]` — the page codec's rule. */
export const DOC_PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type ParsedDocsPageLink = { pageId: string };

export type DocsPageLinkParseResult =
  | { ok: true; value: ParsedDocsPageLink }
  | { ok: false; reason: string };

const DOCS_ROUTE_PREFIX = "/docs/";

/** Relative spellings of a hash route: `#…`, `/#…`, `./#…`. */
const RELATIVE_HASH_LINK = /^(?:\.\/|\/)?#(.*)$/;

/** Build the portable `/#/docs/<pageId>` link for a page. */
export function buildDocsPageLink(pageId: string): string {
  if (!DOC_PAGE_ID_PATTERN.test(pageId)) {
    throw new Error("docsPageLink: invalid page id");
  }
  return `/#${DOCS_ROUTE_PREFIX}${pageId}`;
}

function parseRoute(route: string): DocsPageLinkParseResult {
  if (!route.startsWith(DOCS_ROUTE_PREFIX)) {
    return { ok: false, reason: "not-docs-route" };
  }
  const rest = route.slice(DOCS_ROUTE_PREFIX.length).replace(/\/$/, "");
  if (rest === "") return { ok: false, reason: "missing-page-id" };
  // Extra segments, a query string and percent-escapes all fail the id rule.
  if (!DOC_PAGE_ID_PATTERN.test(rest)) {
    return { ok: false, reason: "invalid-page-id" };
  }
  return { ok: true, value: { pageId: rest } };
}

function currentAppOrigin(): string | undefined {
  const origin = globalThis.location?.origin;
  return origin && origin !== "null" ? origin : undefined;
}

/**
 * Recognize a Docs page link. `appOrigin` (default: this window's origin)
 * is the only host whose absolute URLs count; relative spellings always do.
 */
export function parseDocsPageLink(
  href: string,
  appOrigin: string | undefined = currentAppOrigin(),
): DocsPageLinkParseResult {
  const relative = RELATIVE_HASH_LINK.exec(href);
  if (relative) return parseRoute(relative[1]);
  if (!appOrigin) return { ok: false, reason: "no-app-origin" };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.origin !== appOrigin) return { ok: false, reason: "other-origin" };
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return { ok: false, reason: "other-path" };
  }
  if (url.search) return { ok: false, reason: "unexpected-search" };
  if (!url.hash) return { ok: false, reason: "no-route" };
  return parseRoute(url.hash.slice(1));
}
