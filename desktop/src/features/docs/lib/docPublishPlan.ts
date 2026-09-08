import {
  type DocPage,
  type DocPageContent,
  docPageContentEquals,
  KIND_COMMUNITY_DOC,
} from "./docPageCodec";

export type DocPublishPlan =
  | { kind: "conflict"; newest: DocPage }
  | { kind: "noop"; newest: DocPage }
  | { kind: "publish"; content: DocPageContent & { id: string } };

/**
 * Decides what a write should do once the newest known version of the page
 * (re-read from the relay by `#d`, so it cannot be starved by the shared
 * kind-30078 window) is in hand:
 *
 * - `conflict` when the caller built its edit on `baseEventId` and a newer
 *   version exists — publishing would overwrite work the author never saw.
 * - `noop` when nothing visible would change (tree ops and identical
 *   autosaves must not stack dead versions on the relay). Only a version
 *   already on the dedicated kind counts: an identical write on top of a
 *   legacy (kind-30078) version still publishes, so any touch migrates the
 *   page forward instead of leaving it stranded on the shared window.
 * - `publish` otherwise.
 */
export function planDocPagePublish({
  baseEventId,
  newest,
  next,
}: {
  baseEventId?: string;
  newest: DocPage | undefined;
  next: DocPageContent & { id: string };
}): DocPublishPlan {
  if (newest && baseEventId !== undefined && newest.eventId !== baseEventId) {
    return { kind: "conflict", newest };
  }
  if (
    newest &&
    newest.eventKind === KIND_COMMUNITY_DOC &&
    docPageContentEquals(newest, next)
  ) {
    return { kind: "noop", newest };
  }
  return { kind: "publish", content: next };
}
