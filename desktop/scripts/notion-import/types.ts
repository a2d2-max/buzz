export const IMPORT_FORMAT_VERSION = 1;

import type { PublicDataUrlManifest } from "./dataUrlAssets.ts";

export type ImportedPage = {
  id: string;
  idSource: "notion" | "path-hash";
  /** Private source detail. Intermediate output must stay untracked. */
  sourcePath: string;
  title: string;
  body: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
};

export type ImportedDatabase = {
  /** Private source detail. Intermediate output must stay untracked. */
  sourcePath: string;
  canonical: boolean;
  hasMultilineCells: boolean;
  columns: string[];
  rows: string[][];
  markdown: string;
};

export type UnresolvedLink = {
  pageId: string;
  targetId: string | null;
  reason: "invalid-encoding" | "page-not-found";
};

export type UnresolvedParent = {
  pageId: string;
  candidateParentIds: string[];
  reason: "ambiguous-parent-title";
};

export type AmbiguousRelation = {
  databaseIndex: number;
  rowIndex: number;
  columnIndex: number;
  candidatePageIds: string[];
};

export type UnresolvedRelation = {
  databaseIndex: number;
  rowIndex: number;
  columnIndex: number;
  reason: "title-not-found";
};

export type ConversionFailure = {
  entryIndex: number;
  pageId: string | null;
  reason: string;
};

export type UnsupportedPageSyntax = {
  pageId: string;
  kinds: string[];
};

export type ImportDiagnostics = {
  unresolvedLinks: UnresolvedLink[];
  unresolvedParents: UnresolvedParent[];
  ambiguousRelations: AmbiguousRelation[];
  unresolvedRelations: UnresolvedRelation[];
  unsupportedPageSyntax: UnsupportedPageSyntax[];
  conversionFailures: ConversionFailure[];
};

export type ImportReport = {
  archiveEntryCount: number;
  markdownFileCount: number;
  pageCount: number;
  pageFailureCount: number;
  nativePageIdCount: number;
  syntheticPageIdCount: number;
  unresolvedParentCount: number;
  ambiguousParentFolderCount: number;
  databaseCount: number;
  databaseCsvFileCount: number;
  databaseRowCount: number;
  inlineDatabaseCount: number;
  pageLinkTargetCount: number;
  linkResolvedCount: number;
  linkUnresolvedCount: number;
  relationResolvedCount: number;
  relationAmbiguousCount: number;
  relationUnresolvedCount: number;
  relationNonemptyCellCount: number;
  relationReferenceCount: number;
  relationColumnCount: number;
  attachmentFileCount: number;
  attachmentReferenceCount: number;
  unsupportedSyntax: Record<string, number>;
};

export type NotionImport = {
  version: typeof IMPORT_FORMAT_VERSION;
  source: {
    archivePath: string;
    archiveBytes: number;
  };
  pages: ImportedPage[];
  databases: ImportedDatabase[];
  diagnostics: ImportDiagnostics;
  report: ImportReport;
};

export type UnsignedDocEvent = {
  kind: number;
  tags: string[][];
  content: string;
  /** Input for the desktop signer, in unix seconds. */
  createdAt: number;
};

export type DryRunEvent = {
  pageId: string;
  contentBytes: number;
  unsignedEvent: UnsignedDocEvent;
};

export type PublishFailure = {
  pageId: string;
  bytes: number;
  reason: "page-content-too-large";
};

export type ContentLimitProvenance = {
  advertisedMaxContentBytes: number | null;
  effectiveMaxContentBytes: number;
  source: "advertised" | "legacy-assumption";
  reason:
    | "max-content-length-advertised"
    | "max-content-length-not-advertised"
    | "relay-info-endpoint-unsupported";
  limitVerified: boolean;
  operationalAdvertisementConfirmed: false;
  relayInfoUrl: string;
  relayInfoEndpoint: "/" | "/info";
  relayInfoHttpStatus: number;
  infoEndpointHttpStatus: number;
};

export type DryRunOutput = {
  version: 1;
  mode: "dry-run";
  complete: boolean;
  validationPassed: boolean;
  readyForSigning: boolean;
  readyToPublish: false;
  inputPageCount: number;
  contentLimit: ContentLimitProvenance;
  assetPreparation: PublicDataUrlManifest;
  rejectedParentCount: number;
  dependentEventCount: number;
  relay: string | null;
  events: DryRunEvent[];
  failures: PublishFailure[];
};
