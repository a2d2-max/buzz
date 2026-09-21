import { getIdentity } from "@/shared/api/tauriIdentity";
import { storeDocBlob, type DocBlobScope } from "./docBlobStorage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { getRelayWsUrl, signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
} from "@/shared/constants/kinds";

import { resolveCurrentRelayContentLimit } from "./docContentLimit";
import {
  addDocVersionHeads,
  type DocVersionHeads,
  resolveAllDocVersionHeads,
  resolveDocVersionHeads,
} from "./docStructuredMerge";
import {
  dedicatedDocKindMarkedUnsupported,
  isUnknownKindRejection,
  markDedicatedDocKindAccepted,
  markDedicatedDocKindRejected,
} from "./docKindSupport";
import {
  buildDocPageEventInput,
  COMMUNITY_DOC_QUERY_KINDS,
  createDocPageId,
  type DocPage,
  type DocPageContent,
  docPageDTag,
  measureDocPageContentBytes,
  parseDocPageEvent,
} from "./docPageCodec";
import { planDocPagePublish } from "./docPublishPlan";
import { fetchDocPagesToExhaustion } from "./docsHistory";
import {
  buildDocTree,
  collectDescendantIds,
  type DocTreeNode,
  findDocTreeNode,
  findDocTreeSiblings,
  nextDocEventCreatedAt,
  nextOrderAfter,
  pickLatestDocPages,
  reorderedSiblingOrder,
} from "./docTree";

/** Scoped to the community: the query client is recreated on every switch. */
export const DOCS_PAGES_QUERY_KEY = ["docs", "pages"] as const;

type DocPageMap = Map<string, DocPage>;
type DocsSnapshot = {
  pages: DocPageMap;
  /** Current NIP-33 head for every author/kind coordinate, grouped by page. */
  heads: DocVersionHeads;
  truncated: boolean;
  /** Doc-kind rows (30623 + legacy 30078) the last scan inspected. */
  scanned: number;
  /**
   * Largest relay-validated `created_at` any complete scan has seen;
   * `undefined` after a truncated one or before the first scan. The next
   * scan is incremental from here. Never the local clock: a client running
   * ahead of the relay would otherwise push `since` into the server's future
   * and silently miss every later edit.
   */
  watermark: number | undefined;
};
const EMPTY_PAGES: DocPageMap = new Map();
const EMPTY_HEADS: DocVersionHeads = new Map();
const EMPTY_SNAPSHOT: DocsSnapshot = {
  pages: EMPTY_PAGES,
  heads: EMPTY_HEADS,
  truncated: false,
  scanned: 0,
  watermark: undefined,
};

/**
 * How far below the watermark an incremental scan starts. The relay accepts
 * `created_at` within ±900 s of its own clock at ingest, so the watermark
 * (the newest row seen) may sit up to 900 s ahead of server time, and an
 * event ingested after that scan may be stamped up to 900 s behind server
 * time: two windows apart at worst. 60 s more for good measure.
 */
const INCREMENTAL_LOOKBACK_SECONDS = 2 * 900 + 60;

/** How long the first load waits for the live subscription before fetching anyway. */
const SUBSCRIPTION_SETTLE_TIMEOUT_MS = 3_000;

/** The newest known version of this page is stamped too far in the future to build on. */
export class DocClockSkewError extends Error {
  readonly lastKnownSeconds: number;

  constructor(lastKnownSeconds: number) {
    super(
      "This page's latest version is timestamped in the future; it can't be edited until the clocks catch up.",
    );
    this.name = "DocClockSkewError";
    this.lastKnownSeconds = lastKnownSeconds;
  }
}

/** A newer version than the one the edit was based on exists; nothing was published. */
export class DocConflictError extends Error {
  readonly newest: DocPage;

  constructor(newest: DocPage) {
    super("Someone else saved a newer version of this page.");
    this.name = "DocConflictError";
    this.newest = newest;
  }
}

/** The page would exceed the relay's content ceiling; nothing was signed. */
export class DocTooLargeError extends Error {
  readonly bytes: number;
  readonly maxContentBytes: number;

  constructor(bytes: number, maxContentBytes: number) {
    super(
      `This page is too large to save (${Math.ceil(bytes / 1024)} KB; the relay limit is ${maxContentBytes} bytes).`,
    );
    this.name = "DocTooLargeError";
    this.bytes = bytes;
    this.maxContentBytes = maxContentBytes;
  }
}

export type DocPagePatch = Partial<
  Pick<
    DocPageContent,
    "title" | "body" | "parentId" | "order" | "icon" | "affine" | "affineEpoch"
  >
>;

export type DocUpdateOptions = {
  /**
   * Event id of the version the edit was built on. When given and the relay
   * holds a newer version, the write is refused with {@link DocConflictError}
   * instead of overwriting it. Omit for tree operations, which rebase onto
   * the newest version.
   */
  baseEventId?: string;
};

/** How many versions of one page (one per author) the pre-write re-read asks for. */
const PAGE_VERSIONS_LIMIT = 200;

export type CommunityDocs = {
  pages: DocPageMap;
  tree: DocTreeNode[];
  /** Tombstoned pages, newest deletion first; each can be restored. */
  deletedPages: DocPage[];
  isLoading: boolean;
  isError: boolean;
  /** The history scan hit its bound before the window ended: pages may be missing. */
  truncated: boolean;
  /** Doc-kind rows the last scan inspected (for the truncation notice). */
  scanned: number;
  refetch: () => Promise<unknown>;
  /**
   * Fetches one page by `#d` (SQL-pushed, so it cannot be starved like the
   * history scan) and folds it into the cache. Resolves `undefined` when the
   * relay holds no version of it.
   */
  lookupPage: (id: string) => Promise<DocPage | undefined>;
  createPage: (input: {
    parentId: string | null;
    title?: string;
  }) => Promise<DocPage>;
  /**
   * Republishes `id` with `patch` on top of the newest version the relay
   * holds; also resurrects a tombstoned page. Resolves to the newest version
   * without publishing when nothing visible would change.
   */
  updatePage: (
    id: string,
    patch: DocPagePatch,
    options?: DocUpdateOptions,
  ) => Promise<DocPage>;
  deletePage: (id: string) => Promise<void>;
  restorePage: (id: string) => Promise<DocPage>;
  movePage: (id: string, parentId: string | null) => Promise<void>;
  reorderPage: (id: string, direction: -1 | 1) => Promise<void>;
};

function levelPages(tree: DocTreeNode[], parentId: string | null): DocPage[] {
  const nodes = parentId
    ? (findDocTreeNode(tree, parentId)?.children ?? [])
    : tree;
  return nodes.map((node) => node.page);
}

/**
 * Community-wide page store.
 *
 * Startup order: the live subscription on the doc kinds (30623 + legacy
 * 30078) with `#t=community-doc` is
 * opened first, and only once it is ready does the history scan run — so the
 * two overlap and nothing published in between is missed. Metadata follows
 * the existing relay LWW order while valid BlockSuite/Yjs heads from every
 * author are merged before editing. Writes sign and publish a full page event,
 * then fold the signed copy through that same merge seam. A socket reconnect
 * invalidates the snapshot (the live REQ carries `limit: 0` and replays no
 * history on its own).
 */
export function useCommunityDocs(): CommunityDocs {
  const queryClient = useQueryClient();
  const [subscriptionSettled, setSubscriptionSettled] = React.useState(false);
  const mergeGenerationRef = React.useRef(new Map<string, number>());

  const query = useQuery({
    queryKey: DOCS_PAGES_QUERY_KEY,
    enabled: subscriptionSettled,
    queryFn: async (): Promise<DocsSnapshot> => {
      const previous =
        queryClient.getQueryData<DocsSnapshot>(DOCS_PAGES_QUERY_KEY);
      // A complete earlier scan lets this one walk only what changed since,
      // instead of the whole window on every reconnect.
      const since =
        previous?.watermark !== undefined && !previous.truncated
          ? Math.max(0, previous.watermark - INCREMENTAL_LOOKBACK_SECONDS)
          : undefined;
      let history = await fetchDocPagesToExhaustion({
        fetchEvents: (filter) => relayClient.fetchEvents(filter),
        since,
      });
      // An incremental window can hold more rows than the page budget in a
      // busy community. Rather than warn about missing pages and leave the
      // next load to rescan everything, do the full scan now; only its own
      // truncation is worth a banner.
      if (since !== undefined && history.truncated) {
        history = await fetchDocPagesToExhaustion({
          fetchEvents: (filter) => relayClient.fetchEvents(filter),
        });
      }
      // Live events can land while the scan is in flight. Retain every
      // author/kind head so structured branches can be merged, rather than
      // collapsing to one event before the Yjs consumer sees them.
      const cached =
        queryClient.getQueryData<DocsSnapshot>(DOCS_PAGES_QUERY_KEY);
      let heads = addDocVersionHeads(
        previous?.heads ?? EMPTY_HEADS,
        history.pages,
      );
      if (cached?.heads) {
        heads = addDocVersionHeads(
          heads,
          [...cached.heads.values()].flatMap((versions) => [
            ...versions.values(),
          ]),
        );
      }
      const relayScope = await getRelayWsUrl();
      let pages = await resolveAllDocVersionHeads(heads);
      if ((await getRelayWsUrl()) !== relayScope)
        throw Error("The active community changed while merging documents.");
      // One final bounded fold closes the longer blob-download window. A live
      // callback that wins after this point fences its own async result by the
      // per-page generation below.
      const latestCached =
        queryClient.getQueryData<DocsSnapshot>(DOCS_PAGES_QUERY_KEY);
      if (latestCached?.heads) {
        const latestHeads = addDocVersionHeads(
          heads,
          [...latestCached.heads.values()].flatMap((versions) => [
            ...versions.values(),
          ]),
        );
        if (latestHeads !== heads) {
          heads = latestHeads;
          pages = await resolveAllDocVersionHeads(heads);
          if ((await getRelayWsUrl()) !== relayScope)
            throw Error(
              "The active community changed while merging documents.",
            );
        }
      }
      return {
        pages,
        heads,
        truncated: history.truncated,
        scanned: history.scanned,
        // A shorter incremental scan must not pull the watermark back.
        watermark: history.truncated
          ? undefined
          : [previous?.watermark, history.newestSeen]
              .filter((value): value is number => value !== undefined)
              .reduce<number | undefined>(
                (max, value) =>
                  max === undefined ? value : Math.max(max, value),
                undefined,
              ),
      };
    },
    staleTime: 60_000,
  });

  const applyPages = React.useCallback(
    async (incoming: readonly DocPage[]) => {
      if (incoming.length < 1) return;
      const affected = new Set(incoming.map((page) => page.id));
      const generations = new Map<string, number>();
      for (const id of affected) {
        const generation = (mergeGenerationRef.current.get(id) ?? 0) + 1;
        mergeGenerationRef.current.set(id, generation);
        generations.set(id, generation);
      }
      const captured = new Map<string, Map<string, DocPage>>();
      queryClient.setQueryData<DocsSnapshot>(
        DOCS_PAGES_QUERY_KEY,
        (previous) => {
          const current = previous ?? EMPTY_SNAPSHOT;
          const heads = addDocVersionHeads(current.heads, incoming);
          for (const id of affected) {
            const versions = heads.get(id);
            if (versions) captured.set(id, versions);
          }
          if (heads === current.heads) return current;
          // Metadata remains responsive while large out-of-line snapshots
          // hydrate. The resolved CRDT state replaces these LWW placeholders.
          const pages = pickLatestDocPages([
            ...current.pages.values(),
            ...incoming,
          ]);
          return { ...current, heads, pages };
        },
      );
      const relayScope = await getRelayWsUrl();
      for (const [id, versions] of captured) {
        const resolved = await resolveDocVersionHeads(versions.values());
        if (mergeGenerationRef.current.get(id) !== generations.get(id))
          continue;
        if ((await getRelayWsUrl()) !== relayScope)
          throw Error("The active community changed while merging documents.");
        queryClient.setQueryData<DocsSnapshot>(
          DOCS_PAGES_QUERY_KEY,
          (previous) => {
            if (!previous || previous.heads.get(id) !== versions)
              return previous;
            const pages = new Map(previous.pages);
            pages.set(id, resolved);
            return { ...previous, pages };
          },
        );
      }
    },
    [queryClient],
  );

  const applyEvent = React.useCallback(
    (event: RelayEvent) => {
      const page = parseDocPageEvent(event);
      if (page)
        void applyPages([page]).catch((error) => {
          console.warn("[docs] structured branch merge failed", error);
          void queryClient.invalidateQueries({
            queryKey: DOCS_PAGES_QUERY_KEY,
          });
        });
    },
    [applyPages, queryClient],
  );

  React.useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    const settle = () => {
      if (!cancelled) setSubscriptionSettled(true);
    };
    // A relay that is down must surface as an error, not a long spinner:
    // fetch after a bounded wait even if the subscription never settles.
    const settleTimer = window.setTimeout(
      settle,
      SUBSCRIPTION_SETTLE_TIMEOUT_MS,
    );
    relayClient
      .subscribeLive(
        {
          kinds: [...COMMUNITY_DOC_QUERY_KINDS],
          "#t": [COMMUNITY_DOC_TAG],
          limit: 0,
        },
        (event) => {
          if (!cancelled) applyEvent(event);
        },
        settle,
      )
      .then((stop) => {
        if (cancelled) void stop();
        else unsubscribe = stop;
        // Belt and braces: the REQ is live once this resolves even if the
        // readiness callback was skipped.
        settle();
      })
      // A failed subscription must not block the page list: load it anyway
      // and let the reconnect path re-establish the live feed.
      .catch(settle);
    const unsubscribeReconnect = relayClient.subscribeToReconnects(() => {
      if (cancelled) return;
      void queryClient.invalidateQueries({ queryKey: DOCS_PAGES_QUERY_KEY });
    });
    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      unsubscribeReconnect();
      if (unsubscribe) void unsubscribe();
    };
  }, [applyEvent, queryClient]);

  const snapshot = query.data ?? EMPTY_SNAPSHOT;
  const pages = snapshot.pages;
  const tree = React.useMemo(() => buildDocTree(pages.values()), [pages]);
  const deletedPages = React.useMemo(
    () =>
      [...pages.values()]
        .filter((page) => page.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [pages],
  );

  const readPages = React.useCallback(
    () =>
      queryClient.getQueryData<DocsSnapshot>(DOCS_PAGES_QUERY_KEY)?.pages ??
      EMPTY_PAGES,
    [queryClient],
  );

  /**
   * Re-reads every author's version of one page. `#d` is pushed down to SQL
   * for NIP-33 kinds, so unlike the shared-window history scan this cannot
   * be starved by read-state traffic. Whatever comes back is folded into the
   * cache so the UI sees the same version the write is judged against.
   */
  const fetchNewestVersion = React.useCallback(
    async (id: string): Promise<DocPage | undefined> => {
      const events = await relayClient.fetchEvents({
        kinds: [...COMMUNITY_DOC_QUERY_KINDS],
        "#d": [docPageDTag(id)],
        limit: PAGE_VERSIONS_LIMIT,
      });
      const versions: DocPage[] = [];
      for (const event of events) {
        const page = parseDocPageEvent(event);
        if (page && page.id === id) versions.push(page);
      }
      await applyPages(versions);
      return readPages().get(id);
    },
    [applyPages, readPages],
  );

  /** Signs and publishes one version on exactly `kind` — no fallback. */
  const publishPageAs = React.useCallback(
    async (
      content: DocPageContent & { id: string },
      kind: number,
      known: DocPage | undefined,
      scope?: DocBlobScope,
    ): Promise<DocPage> => {
      const bytes = measureDocPageContentBytes(content);
      const { relayUrl, maxContentBytes } =
        await resolveCurrentRelayContentLimit();
      if (
        scope &&
        (scope.relay !== relayUrl ||
          (await getIdentity()).pubkey !== scope.pubkey)
      )
        throw new Error(
          "The active community or identity changed before saving.",
        );
      if (bytes > maxContentBytes) {
        throw new DocTooLargeError(bytes, maxContentBytes);
      }
      const createdAt = nextDocEventCreatedAt(
        Math.floor(Date.now() / 1_000),
        known?.eventCreatedAt,
      );
      if (createdAt === null) {
        throw new DocClockSkewError(known?.eventCreatedAt ?? 0);
      }
      const event = await signRelayEvent({
        ...buildDocPageEventInput(content, kind),
        createdAt,
      });
      if (scope && event.pubkey !== scope.pubkey)
        throw new Error("The signing identity changed before saving.");
      const page = parseDocPageEvent(event);
      if (!page) throw new Error("Signed page event did not round-trip.");
      let currentRelayUrl: string;
      try {
        currentRelayUrl = await getRelayWsUrl();
      } catch {
        throw new Error(
          "Could not confirm the active community before saving.",
        );
      }
      if (currentRelayUrl !== relayUrl) {
        throw new Error(
          "The active community changed before the page was saved.",
        );
      }
      await relayClient.publishEvent(
        event,
        "Timed out publishing the page.",
        "Failed to publish the page.",
      );
      await applyPages([page]);
      return page;
    },
    [applyPages],
  );

  /**
   * Regular write path. The community relay may be a stock Buzz relay that
   * predates kind 30623 and rejects it as unknown, and NIP-11 cannot tell
   * us in advance — so the write itself is the probe: try the dedicated
   * kind, and on an "unknown event kind" OK-false remember this relay (per
   * URL, in localStorage, re-checked after a day) and republish the same
   * content on the legacy shared kind. Any other failure propagates
   * unchanged — auth, size, or rate problems must not flip the relay to
   * legacy writes.
   */
  const publishPage = React.useCallback(
    async (
      content: DocPageContent & { id: string },
      known: DocPage | undefined,
      scope?: DocBlobScope,
    ): Promise<DocPage> => {
      // Unknown URL (early Tauri failure): still publish, just without a
      // durable verdict to consult or update.
      const relayUrl = await getRelayWsUrl().catch(() => null);
      if (
        relayUrl !== null &&
        dedicatedDocKindMarkedUnsupported(relayUrl, Date.now())
      ) {
        return publishPageAs(content, KIND_COMMUNITY_DOC_LEGACY, known, scope);
      }
      try {
        const page = await publishPageAs(
          content,
          KIND_COMMUNITY_DOC,
          known,
          scope,
        );
        if (relayUrl !== null) markDedicatedDocKindAccepted(relayUrl);
        return page;
      } catch (error) {
        if (!isUnknownKindRejection(error)) throw error;
        if (relayUrl !== null) {
          markDedicatedDocKindRejected(relayUrl, Date.now());
        }
        return publishPageAs(content, KIND_COMMUNITY_DOC_LEGACY, known, scope);
      }
    },
    [publishPageAs],
  );

  /**
   * One-shot migration off the legacy shared kind: after a complete scan,
   * every page whose newest version still sits on kind 30078 is republished
   * verbatim onto the dedicated kind. The copy carries identical content
   * (timestamps included) and an event `created_at` bumped past the legacy
   * version, so last-write-wins always prefers it — nothing readers see
   * changes, and nothing is lost if this pass dies halfway (the legacy rows
   * stay readable and the next mount retries). Each page is re-read by `#d`
   * first so a page another client migrated or edited meanwhile is skipped.
   */
  const migrationStartedRef = React.useRef(false);
  const migrateLegacyPages = React.useCallback(
    async (candidates: DocPage[]) => {
      // A relay known to reject 30623 has nowhere to migrate to: skip the
      // whole pass instead of failing once per page per mount. When the
      // verdict is stale (or absent) the first candidate below doubles as
      // the probe.
      const relayUrl = await getRelayWsUrl().catch(() => null);
      if (
        relayUrl !== null &&
        dedicatedDocKindMarkedUnsupported(relayUrl, Date.now())
      ) {
        return;
      }
      for (const cached of candidates) {
        try {
          const newest = await fetchNewestVersion(cached.id);
          if (
            !newest ||
            newest.unsupportedEditor ||
            newest.structuredMergeConflict ||
            newest.eventKind !== KIND_COMMUNITY_DOC_LEGACY
          ) {
            continue;
          }
          // The migration must land on the dedicated kind or not happen at
          // all — publishPage's legacy fallback would only stack an
          // identical dead version on the shared window.
          await publishPageAs(
            {
              id: newest.id,
              title: newest.title,
              body: newest.body,
              ...(newest.affine ? { affine: newest.affine } : {}),
              ...(newest.affineEpoch
                ? { affineEpoch: newest.affineEpoch }
                : {}),
              parentId: newest.parentId,
              order: newest.order,
              ...(newest.icon ? { icon: newest.icon } : {}),
              createdAt: newest.createdAt,
              updatedAt: newest.updatedAt,
              ...(newest.deleted ? { deleted: true } : {}),
            },
            KIND_COMMUNITY_DOC,
            newest,
          );
          if (relayUrl !== null) markDedicatedDocKindAccepted(relayUrl);
        } catch (error) {
          if (isUnknownKindRejection(error)) {
            // The relay does not know 30623: every remaining candidate
            // would fail identically. Remember the verdict and stop.
            if (relayUrl !== null) {
              markDedicatedDocKindRejected(relayUrl, Date.now());
            }
            return;
          }
          // Best-effort: a failed republish (offline, clock skew) leaves the
          // page on the legacy window, which is still read. Retried next mount.
        }
      }
    },
    [fetchNewestVersion, publishPageAs],
  );
  const snapshotForMigration = query.data;
  React.useEffect(() => {
    if (migrationStartedRef.current) return;
    // A truncated scan may have missed the dedicated-kind successor of a
    // legacy row; only a complete window is safe to migrate from.
    if (!snapshotForMigration || snapshotForMigration.truncated) return;
    migrationStartedRef.current = true;
    const candidates = [...snapshotForMigration.pages.values()].filter(
      (page) => page.eventKind === KIND_COMMUNITY_DOC_LEGACY,
    );
    if (candidates.length > 0) void migrateLegacyPages(candidates);
  }, [migrateLegacyPages, snapshotForMigration]);

  const createPage = React.useCallback<CommunityDocs["createPage"]>(
    async ({ parentId, title }) => {
      const now = Date.now();
      return publishPage(
        {
          id: createDocPageId(),
          title: title?.trim() ?? "",
          body: "",
          parentId,
          order: nextOrderAfter(levelPages(tree, parentId)),
          createdAt: now,
          updatedAt: now,
        },
        undefined,
      );
    },
    [publishPage, tree],
  );

  /**
   * Shared write path: re-read, plan, publish. `patch.deleted` sets or clears
   * the tombstone; left undefined it is carried over from the newest version.
   * `requireLive` refuses to touch a page that was deleted meanwhile, so a
   * tree operation racing a delete cannot bring the page back.
   */
  const republish = React.useCallback(
    async (
      id: string,
      patch: DocPagePatch & { deleted?: boolean },
      options?: DocUpdateOptions & { requireLive?: boolean },
    ): Promise<DocPage> => {
      const newest = await fetchNewestVersion(id);
      if (!newest) throw new Error("This page does not exist on the relay.");
      if (options?.requireLive && newest.deleted) {
        throw new Error("This page was deleted by someone else.");
      }
      // On a relay that rejects 30623 an identical write on a legacy
      // version is a plain noop again — there is no migration to force.
      const relayUrl = await getRelayWsUrl().catch(() => null);
      const plan = planDocPagePublish({
        baseEventId: options?.baseEventId,
        dedicatedKindSupported:
          relayUrl === null ||
          !dedicatedDocKindMarkedUnsupported(relayUrl, Date.now()),
        newest,
        next: {
          id,
          title: newest.title,
          body: newest.body,
          ...(newest.affine ? { affine: newest.affine } : {}),
          ...(newest.affineEpoch ? { affineEpoch: newest.affineEpoch } : {}),
          parentId: newest.parentId,
          order: newest.order,
          icon: newest.icon,
          createdAt: newest.createdAt,
          deleted: newest.deleted,
          ...patch,
          updatedAt: Date.now(),
        },
      });
      if (plan.kind === "conflict") throw new DocConflictError(plan.newest);
      if (plan.kind === "noop") return plan.newest;
      let uploadScope: DocBlobScope | undefined;
      const stored = await storeDocBlob(plan.content, undefined, (scope) => {
        uploadScope = scope;
      });
      if (stored !== plan.content) {
        const current = await fetchNewestVersion(id);
        if (!current || current.eventId !== newest.eventId) {
          if (current) throw new DocConflictError(current);
          throw new Error("The document disappeared during upload.");
        }
      }
      return publishPage(stored, newest, uploadScope);
    },
    [fetchNewestVersion, publishPage],
  );

  const updatePage = React.useCallback<CommunityDocs["updatePage"]>(
    // A tombstoned newest version is fine: the republished copy carries no
    // `deleted` flag and, being newer, brings the page back.
    (id, patch, options) =>
      republish(id, { ...patch, deleted: false }, options),
    [republish],
  );

  const deletePage = React.useCallback<CommunityDocs["deletePage"]>(
    async (id) => {
      await republish(id, { deleted: true, affineEpoch: crypto.randomUUID() });
    },
    [republish],
  );

  const restorePage = React.useCallback<CommunityDocs["restorePage"]>(
    (id) => updatePage(id, {}),
    [updatePage],
  );

  const movePage = React.useCallback<CommunityDocs["movePage"]>(
    async (id, parentId) => {
      if (parentId === id) return;
      if (parentId !== null) {
        const target = readPages().get(parentId);
        if (!target || target.deleted) {
          throw new Error("The destination page no longer exists.");
        }
        if (collectDescendantIds(tree, id).has(parentId)) {
          throw new Error(
            "A page cannot be moved inside one of its own pages.",
          );
        }
      }
      await republish(
        id,
        { parentId, order: nextOrderAfter(levelPages(tree, parentId)) },
        { requireLive: true },
      );
    },
    [readPages, republish, tree],
  );

  const reorderPage = React.useCallback<CommunityDocs["reorderPage"]>(
    async (id, direction) => {
      const siblings = findDocTreeSiblings(tree, id);
      if (!siblings) return;
      const index = siblings.findIndex((node) => node.page.id === id);
      const order = reorderedSiblingOrder(
        siblings.map((node) => node.page),
        index,
        direction,
      );
      if (order === null) return;
      await republish(id, { order }, { requireLive: true });
    },
    [republish, tree],
  );

  return {
    pages,
    tree,
    deletedPages,
    isLoading: query.isPending,
    isError: query.isError,
    truncated: snapshot.truncated,
    scanned: snapshot.scanned,
    refetch: query.refetch,
    lookupPage: fetchNewestVersion,
    createPage,
    updatePage,
    deletePage,
    restorePage,
    movePage,
    reorderPage,
  };
}
