import { createHash } from "node:crypto";

import {
  buildDocPageEventInput,
  docPageContentEquals,
  docPageDTag,
  docPageIdFromDTag,
  measureDocPageContentBytes,
  parseDocPageEvent,
} from "../../src/features/docs/lib/docPageCodec.ts";
import type { RelayEvent } from "../../src/shared/api/types.ts";
import type { PublicationBindingStatus } from "./publicationBindings.ts";
import { orderPagesForPublish } from "./publish.ts";
import type {
  ContentLimitProvenance,
  DryRunEvent,
  ImportedPage,
  NotionImport,
} from "./types.ts";

export type PublicationPreflightFailure = {
  pageId: string | null;
  bytes: number | null;
  reason:
    | "codec-round-trip-failed"
    | "dangling-parent"
    | "duplicate-page-id"
    | "invalid-page-id"
    | "page-content-too-large"
    | "page-denominator-mismatch"
    | "page-tree-invalid";
};

export type PublicationPreflight = {
  version: 1;
  mode: "publication-preflight";
  inputPageCount: number;
  uniquePageIdCount: number;
  validParentCount: number;
  codecValidatedPageCount: number;
  contentValidatedPageCount: number;
  corpusSha256: string;
  complete: boolean;
  readyForSigning: boolean;
  readyToPublish: false;
  readinessBlockers: string[];
  bindingStatus: PublicationBindingStatus;
  contentLimit: ContentLimitProvenance;
  events: DryRunEvent[];
  failures: PublicationPreflightFailure[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pageContent(page: ImportedPage) {
  return {
    id: page.id,
    title: page.title,
    body: page.body,
    parentId: page.parentId,
    order: page.order,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function codecRoundTrips(page: ImportedPage): boolean {
  const content = pageContent(page);
  const input = buildDocPageEventInput(content);
  const decoded = parseDocPageEvent({
    id: "0".repeat(64),
    pubkey: "1".repeat(64),
    created_at: 1,
    kind: input.kind,
    tags: input.tags,
    content: input.content,
    sig: "2".repeat(128),
  } satisfies RelayEvent);
  return (
    decoded !== null &&
    decoded.id === page.id &&
    docPageContentEquals(decoded, content)
  );
}

/** Build a batch-atomic signable plan from final URL-bound page bodies. */
export function buildPublicationPreflight({
  imported,
  bindingStatus,
  contentLimit,
}: {
  imported: NotionImport;
  bindingStatus: PublicationBindingStatus;
  contentLimit: ContentLimitProvenance;
}): PublicationPreflight {
  const failures: PublicationPreflightFailure[] = [];
  const ids = new Set<string>();
  for (const page of imported.pages) {
    if (ids.has(page.id)) {
      failures.push({
        pageId: page.id,
        bytes: null,
        reason: "duplicate-page-id",
      });
    }
    ids.add(page.id);
    if (docPageIdFromDTag(docPageDTag(page.id)) !== page.id) {
      failures.push({
        pageId: page.id,
        bytes: null,
        reason: "invalid-page-id",
      });
    }
  }
  if (
    imported.pages.length !== imported.report.pageCount ||
    imported.report.pageCount !== imported.report.markdownFileCount ||
    imported.report.pageFailureCount !== 0
  ) {
    failures.push({
      pageId: null,
      bytes: null,
      reason: "page-denominator-mismatch",
    });
  }

  let validParentCount = 0;
  for (const page of imported.pages) {
    if (page.parentId === null) continue;
    if (!ids.has(page.parentId) || page.parentId === page.id) {
      failures.push({
        pageId: page.id,
        bytes: null,
        reason: "dangling-parent",
      });
    } else {
      validParentCount += 1;
    }
  }

  let ordered: ImportedPage[] = [];
  if (failures.length === 0) {
    try {
      ordered = orderPagesForPublish(imported.pages);
    } catch {
      failures.push({ pageId: null, bytes: null, reason: "page-tree-invalid" });
    }
  }

  const candidateEvents: DryRunEvent[] = [];
  let codecValidatedPageCount = 0;
  let contentValidatedPageCount = 0;
  if (failures.length === 0) {
    for (const page of ordered) {
      if (!codecRoundTrips(page)) {
        failures.push({
          pageId: page.id,
          bytes: null,
          reason: "codec-round-trip-failed",
        });
        continue;
      }
      codecValidatedPageCount += 1;
      const content = pageContent(page);
      const bytes = measureDocPageContentBytes(content);
      if (bytes > contentLimit.effectiveMaxContentBytes) {
        failures.push({
          pageId: page.id,
          bytes,
          reason: "page-content-too-large",
        });
        continue;
      }
      contentValidatedPageCount += 1;
      candidateEvents.push({
        pageId: page.id,
        contentBytes: bytes,
        unsignedEvent: {
          ...buildDocPageEventInput(content),
          createdAt: 0,
        },
      });
    }
  }
  const complete = failures.length === 0;
  const events = complete ? candidateEvents : [];
  const corpusSha256 = sha256(
    JSON.stringify(
      ordered.map((page) => ({
        pageId: page.id,
        parentId: page.parentId,
        contentSha256: sha256(
          buildDocPageEventInput(pageContent(page)).content,
        ),
      })),
    ),
  );
  const readinessBlockers: string[] = [];
  if (!complete) readinessBlockers.push("validation-failed");
  if (!bindingStatus.productionBindingsComplete) {
    readinessBlockers.push("production-asset-bindings-missing");
  }
  if (!contentLimit.limitVerified)
    readinessBlockers.push("relay-limit-unverified");
  if (!contentLimit.operationalAdvertisementConfirmed) {
    readinessBlockers.push("operational-advertisement-unconfirmed");
  }
  const readyForSigning = readinessBlockers.length === 0;
  return {
    version: 1,
    mode: "publication-preflight",
    inputPageCount: imported.pages.length,
    uniquePageIdCount: ids.size,
    validParentCount,
    codecValidatedPageCount,
    contentValidatedPageCount,
    corpusSha256,
    complete,
    readyForSigning,
    readyToPublish: false,
    readinessBlockers,
    bindingStatus,
    contentLimit,
    events,
    failures,
  };
}
