/**
 * Local backup of a page draft that could not be published.
 *
 * Autosave already keeps a failed draft dirty for retry, but that record lives
 * in memory and dies with the editor (navigation, reload, crash). This mirror
 * is the durable half: written when a save fails, cleared when one succeeds,
 * and offered back the next time the page opens.
 */

export type DocDraftBackup = {
  title: string;
  body: string;
  /** Unix ms when the backup was taken. */
  savedAt: number;
};

export type DocDraftStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const KEY_PREFIX = "buzz.docs.draft-backup.v1.";

export function docDraftBackupKey(pageId: string): string {
  return `${KEY_PREFIX}${pageId}`;
}

export function readDocDraftBackup(
  storage: DocDraftStorage | null | undefined,
  pageId: string,
): DocDraftBackup | null {
  try {
    const raw = storage?.getItem(docDraftBackupKey(pageId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.title !== "string" ||
      typeof candidate.body !== "string" ||
      typeof candidate.savedAt !== "number" ||
      !Number.isFinite(candidate.savedAt)
    ) {
      return null;
    }
    return {
      title: candidate.title,
      body: candidate.body,
      savedAt: candidate.savedAt,
    };
  } catch {
    return null;
  }
}

/** Returns whether the mirror write landed; callers keep the in-memory draft either way. */
export function writeDocDraftBackup(
  storage: DocDraftStorage | null | undefined,
  pageId: string,
  draft: DocDraftBackup,
): boolean {
  try {
    storage?.setItem(docDraftBackupKey(pageId), JSON.stringify(draft));
    return storage !== null && storage !== undefined;
  } catch {
    return false;
  }
}

export function clearDocDraftBackup(
  storage: DocDraftStorage | null | undefined,
  pageId: string,
): void {
  try {
    storage?.removeItem(docDraftBackupKey(pageId));
  } catch {
    // Nothing to recover from: a stale backup is offered again and declined.
  }
}
