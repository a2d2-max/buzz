import {
  buildDocPageEventInput,
  docPageDTag,
  docPageIdFromDTag,
  measureDocPageContentBytes,
} from "../../src/features/docs/lib/docPageCodec.ts";
import type {
  ContentLimitProvenance,
  DryRunOutput,
  ImportedPage,
  NotionImport,
} from "./types.ts";
import type { PublicDataUrlManifest } from "./dataUrlAssets.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePage(value: unknown, index: number): ImportedPage {
  if (!isRecord(value)) throw new Error(`invalid-page:${index}`);
  const id = value.id;
  if (
    typeof id !== "string" ||
    docPageIdFromDTag(docPageDTag(id)) !== id ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.order !== "number" ||
    !Number.isFinite(value.order) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    throw new Error(`invalid-page:${index}`);
  }
  return value as ImportedPage;
}

export function parseIntermediate(value: unknown): NotionImport {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.pages)) {
    throw new Error("invalid-intermediate-format");
  }
  const pages = value.pages.map(validatePage);
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) throw new Error(`duplicate-page-id:${page.id}`);
    seen.add(page.id);
  }
  return { ...value, pages } as NotionImport;
}

function comparePages(a: ImportedPage, b: ImportedPage): number {
  if (a.order !== b.order) return a.order - b.order;
  const byTitle = a.title.localeCompare(b.title);
  return byTitle === 0 ? a.id.localeCompare(b.id) : byTitle;
}

/** Depth-first Docs display order: parent, then its ordered children. */
export function orderPagesForPublish(pages: ImportedPage[]): ImportedPage[] {
  const ids = new Set(pages.map((page) => page.id));
  const children = new Map<string | null, ImportedPage[]>();
  for (const page of pages) {
    const parentId =
      page.parentId !== null && ids.has(page.parentId) ? page.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(page);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(comparePages);

  const ordered: ImportedPage[] = [];
  const visited = new Set<string>();
  const visit = (page: ImportedPage) => {
    if (visited.has(page.id)) return;
    visited.add(page.id);
    ordered.push(page);
    for (const child of children.get(page.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  if (visited.size !== pages.length) throw new Error("page-tree-cycle");
  return ordered;
}

function normalizeRelay(relay: string | undefined): string | null {
  if (relay === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(relay);
  } catch {
    throw new Error("invalid-relay-url");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("invalid-relay-url");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("invalid-relay-url");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/** Builds signer inputs only. It never opens a socket or asks for a key. */
export function buildDryRun({
  imported,
  assetPreparation,
  contentLimit,
  relay,
  createdAt = Math.floor(Date.now() / 1_000),
}: {
  imported: NotionImport;
  assetPreparation: PublicDataUrlManifest;
  contentLimit: ContentLimitProvenance;
  relay?: string;
  createdAt?: number;
}): DryRunOutput {
  const output: DryRunOutput = {
    version: 1,
    mode: "dry-run",
    complete: false,
    validationPassed: false,
    readyForSigning: false,
    readyToPublish: false,
    inputPageCount: imported.pages.length,
    contentLimit,
    assetPreparation,
    rejectedParentCount: 0,
    dependentEventCount: 0,
    relay: normalizeRelay(relay),
    events: [],
    failures: [],
  };
  for (const page of orderPagesForPublish(imported.pages)) {
    const content = {
      id: page.id,
      title: page.title,
      body: page.body,
      parentId: page.parentId,
      order: page.order,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
    const bytes = measureDocPageContentBytes(content);
    if (bytes > contentLimit.effectiveMaxContentBytes) {
      output.failures.push({
        pageId: page.id,
        bytes,
        reason: "page-content-too-large",
      });
      continue;
    }
    output.events.push({
      pageId: page.id,
      contentBytes: bytes,
      unsignedEvent: {
        ...buildDocPageEventInput(content),
        createdAt,
      },
    });
  }
  const rejectedIds = new Set(output.failures.map((failure) => failure.pageId));
  const pagesById = new Map(imported.pages.map((page) => [page.id, page]));
  const rejectedParents = new Set<string>();
  for (const event of output.events) {
    const parentId = pagesById.get(event.pageId)?.parentId ?? null;
    if (parentId !== null && rejectedIds.has(parentId)) {
      output.dependentEventCount += 1;
      rejectedParents.add(parentId);
    }
  }
  output.rejectedParentCount = rejectedParents.size;
  output.complete = output.failures.length === 0;
  output.validationPassed = output.complete;
  output.readyForSigning =
    output.validationPassed && assetPreparation.assetBindingsComplete;
  return output;
}
