import { mergeSnapshotPayloads } from "../../../../../docs-editor/src/snapshotMerge";

import type { DocPage } from "./docPageCodec";
import { loadDocBlob } from "./docBlobStorage";
import { compareDocPageVersions } from "./docTree";

export type DocVersionHeads = Map<string, Map<string, DocPage>>;

function coordinate(page: DocPage) {
  return `${page.eventKind}:${page.author}`;
}

/** Keep the newest relay head for every NIP-33 author/kind coordinate. */
export function addDocVersionHeads(
  current: DocVersionHeads,
  incoming: Iterable<DocPage>,
): DocVersionHeads {
  let next = current;
  for (const page of incoming) {
    const existingByAuthor = next.get(page.id);
    const existing = existingByAuthor?.get(coordinate(page));
    if (existing && compareDocPageVersions(page, existing) <= 0) continue;
    if (next === current) next = new Map(current);
    const byAuthor = new Map(existingByAuthor);
    byAuthor.set(coordinate(page), page);
    next.set(page.id, byAuthor);
  }
  return next;
}

function latest(versions: readonly DocPage[]) {
  return versions.reduce((winner, page) =>
    compareDocPageVersions(page, winner) > 0 ? page : winner,
  );
}

/**
 * Resolve metadata with the existing relay LWW policy, then CRDT-merge every
 * live structured branch newer than the latest tombstone. Old pre-delete Yjs
 * state can therefore never reappear after a restore.
 */
export async function resolveDocVersionHeads(
  versions: Iterable<DocPage>,
  hydrate: (page: DocPage) => Promise<DocPage> = loadDocBlob,
): Promise<DocPage> {
  const all = [...versions];
  if (all.length < 1) throw Error("No document versions to resolve.");
  const winner = latest(all);
  if (winner.deleted) return winner;
  const epochs = all.filter((page) => page.affineEpoch !== undefined);
  const activeEpoch =
    epochs.length > 0 ? latest(epochs).affineEpoch : undefined;
  const tombstones = all.filter((page) => page.deleted);
  const latestTombstone = tombstones.length > 0 ? latest(tombstones) : null;
  const afterDeletion = (page: DocPage) =>
    latestTombstone === null ||
    compareDocPageVersions(page, latestTombstone) > 0;
  const live = all.filter(
    (page) =>
      !page.deleted &&
      (activeEpoch !== undefined
        ? page.affineEpoch === activeEpoch
        : afterDeletion(page)),
  );
  if (live.some((page) => page.unsupportedEditor)) {
    const current = latest(live);
    return {
      ...winner,
      affine: current.affine,
      ...(activeEpoch ? { affineEpoch: activeEpoch } : {}),
      unsupportedEditor: true,
    };
  }
  const structured = live.filter((page) => page.affine !== undefined);
  if (structured.length < 1) {
    if (activeEpoch === undefined) return winner;
    const { affine: _staleAffine, ...metadata } = winner;
    return { ...metadata, affineEpoch: activeEpoch };
  }
  const hydrated: DocPage[] = [];
  for (const page of structured) hydrated.push(await hydrate(page));
  try {
    const affine = mergeSnapshotPayloads(
      hydrated.flatMap((page) => (page.affine ? [page.affine] : [])),
    );
    return {
      ...winner,
      affine,
      ...(activeEpoch ? { affineEpoch: activeEpoch } : {}),
      unsupportedEditor: false,
      structuredMergeConflict: false,
    };
  } catch {
    // The newest Markdown preview remains readable, but editing must not pick
    // one conflicting attachment or malformed branch and overwrite the rest.
    return {
      ...winner,
      ...(activeEpoch ? { affineEpoch: activeEpoch } : {}),
      structuredMergeConflict: true,
    };
  }
}

/** Resolve all document ids sequentially so blob downloads stay bounded. */
export async function resolveAllDocVersionHeads(
  heads: DocVersionHeads,
): Promise<Map<string, DocPage>> {
  const pages = new Map<string, DocPage>();
  for (const [id, versions] of heads) {
    pages.set(id, await resolveDocVersionHeads(versions.values()));
  }
  return pages;
}
