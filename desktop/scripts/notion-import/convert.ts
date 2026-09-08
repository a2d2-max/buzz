import { createHash } from "node:crypto";
import path from "node:path";

import { convertCsvEntry, type TitleIndex } from "./csv.ts";
import { convertMarkdown, extractPageDocument } from "./markdown.ts";
import {
  IMPORT_FORMAT_VERSION,
  type ConversionFailure,
  type ImportedPage,
  type NotionImport,
  type UnresolvedParent,
} from "./types.ts";
import { readNotionZip, type ZipTextEntry } from "./zipReader.ts";

type PageDraft = Omit<ImportedPage, "body" | "parentId" | "order"> & {
  archiveIndex: number;
  sourceTitle: string;
  sourceBody: string;
};

const NOTION_ID_SUFFIX = /(?:^|\s)([0-9a-f]{32})\.md$/i;

function notionIdFromPath(sourcePath: string): string | null {
  return (
    path.posix
      .basename(sourcePath)
      .match(NOTION_ID_SUFFIX)?.[1]
      ?.toLowerCase() ?? null
  );
}

function sourceTitleFromPath(sourcePath: string): string {
  return path.posix
    .basename(sourcePath, ".md")
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .trim();
}

function syntheticPageId(sourcePath: string): string {
  const digest = createHash("sha256").update(sourcePath).digest("hex");
  return `notion-${digest.slice(0, 32)}`;
}

function directoryTitleKey(directory: string, title: string): string {
  return `${directory}\0${title.normalize("NFC")}`;
}

function draftFromEntry(entry: ZipTextEntry): PageDraft {
  const notionId = notionIdFromPath(entry.path);
  const document = extractPageDocument(entry.path, entry.text);
  const modifiedAtMs = Number.isFinite(entry.modifiedAtMs)
    ? entry.modifiedAtMs
    : 0;
  return {
    id: notionId ?? syntheticPageId(entry.path),
    idSource: notionId ? "notion" : "path-hash",
    sourcePath: entry.path,
    sourceTitle: sourceTitleFromPath(entry.path),
    title: document.title,
    sourceBody: document.body,
    createdAt: modifiedAtMs,
    updatedAt: modifiedAtMs,
    archiveIndex: entry.archiveIndex,
  };
}

function resolveParents(drafts: PageDraft[]): {
  parentById: Map<string, string | null>;
  unresolvedParents: UnresolvedParent[];
  ambiguousFolders: number;
} {
  const pagesByDirectoryAndTitle = new Map<string, PageDraft[]>();
  for (const draft of drafts) {
    const key = directoryTitleKey(
      path.posix.dirname(draft.sourcePath),
      draft.sourceTitle,
    );
    const candidates = pagesByDirectoryAndTitle.get(key) ?? [];
    candidates.push(draft);
    pagesByDirectoryAndTitle.set(key, candidates);
  }

  const parentById = new Map<string, string | null>();
  const unresolvedParents: UnresolvedParent[] = [];
  const ambiguousFolderPaths = new Set<string>();
  for (const draft of drafts) {
    let directory = path.posix.dirname(draft.sourcePath);
    let parentId: string | null = null;
    while (directory !== "." && directory !== "/") {
      const folderTitle = sourceTitleFromPath(
        `${path.posix.basename(directory)}.md`,
      );
      const candidates = (
        pagesByDirectoryAndTitle.get(
          directoryTitleKey(path.posix.dirname(directory), folderTitle),
        ) ?? []
      ).filter((candidate) => candidate.id !== draft.id);
      if (candidates.length === 1) {
        parentId = candidates[0].id;
        break;
      }
      if (candidates.length > 1) {
        ambiguousFolderPaths.add(directory);
        unresolvedParents.push({
          pageId: draft.id,
          candidateParentIds: candidates
            .map((candidate) => candidate.id)
            .sort(),
          reason: "ambiguous-parent-title",
        });
        break;
      }
      const next = path.posix.dirname(directory);
      if (next === directory) break;
      directory = next;
    }
    parentById.set(draft.id, parentId);
  }
  return {
    parentById,
    unresolvedParents,
    ambiguousFolders: ambiguousFolderPaths.size,
  };
}

function assignSiblingOrders(
  drafts: PageDraft[],
  parentById: Map<string, string | null>,
): Map<string, number> {
  const groups = new Map<string | null, PageDraft[]>();
  for (const draft of drafts) {
    const parentId = parentById.get(draft.id) ?? null;
    const siblings = groups.get(parentId) ?? [];
    siblings.push(draft);
    groups.set(parentId, siblings);
  }
  const orders = new Map<string, number>();
  for (const siblings of groups.values()) {
    const ordered = siblings.sort(
      (a, b) => a.archiveIndex - b.archiveIndex || a.id.localeCompare(b.id),
    );
    for (const [index, draft] of ordered.entries()) {
      orders.set(draft.id, index);
    }
  }
  return orders;
}

function makeTitleIndex(drafts: PageDraft[]): TitleIndex {
  const index: TitleIndex = new Map();
  for (const draft of drafts) {
    const ids = index.get(draft.title) ?? [];
    ids.push(draft.id);
    index.set(draft.title, ids);
  }
  return index;
}

function safeFailure(
  entryIndex: number,
  pageId: string | null,
  error: unknown,
): ConversionFailure {
  const reason =
    error instanceof Error && error.message === "duplicate-page-id"
      ? "duplicate-page-id"
      : "page-conversion-failed";
  return { entryIndex, pageId, reason };
}

export async function convertNotionArchive(
  archivePath: string,
  relationColumns: ReadonlySet<string> = new Set(),
): Promise<NotionImport> {
  const archive = await readNotionZip(archivePath);
  const markdownEntries = archive.textEntries.filter((entry) =>
    entry.path.toLowerCase().endsWith(".md"),
  );
  const csvEntries = archive.textEntries.filter((entry) =>
    entry.path.toLowerCase().endsWith(".csv"),
  );
  const conversionFailures: ConversionFailure[] = [];
  const drafts: PageDraft[] = [];
  const seenPageIds = new Set<string>();

  for (const entry of markdownEntries) {
    const expectedId =
      notionIdFromPath(entry.path) ?? syntheticPageId(entry.path);
    try {
      if (seenPageIds.has(expectedId)) throw new Error("duplicate-page-id");
      const draft = draftFromEntry(entry);
      seenPageIds.add(draft.id);
      drafts.push(draft);
    } catch (error) {
      conversionFailures.push(
        safeFailure(entry.archiveIndex, expectedId, error),
      );
    }
  }

  const { parentById, unresolvedParents, ambiguousFolders } =
    resolveParents(drafts);
  const orderById = assignSiblingOrders(drafts, parentById);
  const titleIndex = makeTitleIndex(drafts);

  const databases = [];
  const canonicalDatabaseConversions = [];
  for (const [databaseIndex, entry] of csvEntries.entries()) {
    try {
      const converted = convertCsvEntry({
        entry,
        databaseIndex,
        titleIndex,
        relationColumns,
      });
      databases.push(converted.database);
      if (converted.database.canonical) {
        canonicalDatabaseConversions.push(converted);
      }
    } catch {
      throw new Error(`csv-parse-failed:entry-index=${entry.archiveIndex}`);
    }
  }
  const databaseBySourcePath = new Map(
    databases.map((database) => [database.sourcePath, database]),
  );
  const pageIdBySourcePath = new Map(
    drafts.map((draft) => [draft.sourcePath, draft.id]),
  );
  const attachmentPaths = new Set(
    archive.attachments.map((attachment) => attachment.path),
  );

  const pages: ImportedPage[] = [];
  const unresolvedLinks = [];
  const unsupportedPageSyntax = [];
  const unsupportedSyntax: Record<string, number> = {};
  let linkResolvedCount = 0;
  let inlineDatabaseCount = 0;
  let attachmentReferenceCount = 0;
  for (const draft of drafts) {
    try {
      const converted = convertMarkdown({
        pageId: draft.id,
        sourcePath: draft.sourcePath,
        body: draft.sourceBody,
        pageIdBySourcePath,
        pageIds: seenPageIds,
        databaseBySourcePath,
        attachmentPaths,
      });
      pages.push({
        id: draft.id,
        idSource: draft.idSource,
        sourcePath: draft.sourcePath,
        title: draft.title,
        body: converted.body,
        parentId: parentById.get(draft.id) ?? null,
        order: orderById.get(draft.id) ?? 0,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      });
      linkResolvedCount += converted.resolvedLinks;
      inlineDatabaseCount += converted.inlineDatabases;
      attachmentReferenceCount += converted.attachmentReferences;
      unresolvedLinks.push(...converted.unresolvedLinks);
      if (converted.unsupportedSyntax.length > 0) {
        unsupportedPageSyntax.push({
          pageId: draft.id,
          kinds: converted.unsupportedSyntax,
        });
      }
      for (const kind of converted.unsupportedSyntax) {
        unsupportedSyntax[kind] = (unsupportedSyntax[kind] ?? 0) + 1;
      }
    } catch (error) {
      conversionFailures.push(safeFailure(draft.archiveIndex, draft.id, error));
    }
  }

  const relationResolvedCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationResolvedCount,
    0,
  );
  const relationAmbiguousCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationAmbiguousCount,
    0,
  );
  const relationColumnCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationColumnCount,
    0,
  );
  const relationUnresolvedCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationUnresolvedCount,
    0,
  );
  const relationNonemptyCellCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationNonemptyCellCount,
    0,
  );
  const relationReferenceCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.relationReferenceCount,
    0,
  );
  const ambiguousRelations = canonicalDatabaseConversions.flatMap(
    (conversion) => conversion.ambiguousRelations,
  );
  const unresolvedRelations = canonicalDatabaseConversions.flatMap(
    (conversion) => conversion.unresolvedRelations,
  );
  const databaseRowCount = canonicalDatabaseConversions.reduce(
    (total, conversion) => total + conversion.database.rows.length,
    0,
  );

  return {
    version: IMPORT_FORMAT_VERSION,
    source: {
      archivePath,
      archiveBytes: archive.archiveBytes,
    },
    pages,
    databases,
    diagnostics: {
      unresolvedLinks,
      unresolvedParents,
      ambiguousRelations,
      unresolvedRelations,
      unsupportedPageSyntax,
      conversionFailures,
    },
    report: {
      archiveEntryCount: archive.archiveEntryCount,
      markdownFileCount: markdownEntries.length,
      pageCount: pages.length,
      pageFailureCount: conversionFailures.length,
      nativePageIdCount: drafts.filter((draft) => draft.idSource === "notion")
        .length,
      syntheticPageIdCount: drafts.filter(
        (draft) => draft.idSource === "path-hash",
      ).length,
      unresolvedParentCount: unresolvedParents.length,
      ambiguousParentFolderCount: ambiguousFolders,
      databaseCount: canonicalDatabaseConversions.length,
      databaseCsvFileCount: csvEntries.length,
      databaseRowCount,
      inlineDatabaseCount,
      pageLinkTargetCount: linkResolvedCount + unresolvedLinks.length,
      linkResolvedCount,
      linkUnresolvedCount: unresolvedLinks.length,
      relationResolvedCount,
      relationAmbiguousCount,
      relationUnresolvedCount,
      relationNonemptyCellCount,
      relationReferenceCount,
      relationColumnCount,
      attachmentFileCount: archive.attachments.length,
      attachmentReferenceCount,
      unsupportedSyntax,
    },
  };
}
