import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
} from "@/shared/constants/kinds";

import {
  buildDocPageEventInput,
  createDocPageId,
  type DocPage,
  type DocPageContent,
  parseDocPageEvent,
} from "./docPageCodec";
import { fetchDocPagesToExhaustion } from "./docsHistory";
import {
  applyDocPageVersion,
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
type DocsSnapshot = { pages: DocPageMap; truncated: boolean };
const EMPTY_PAGES: DocPageMap = new Map();
const EMPTY_SNAPSHOT: DocsSnapshot = { pages: EMPTY_PAGES, truncated: false };

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

export type DocPagePatch = Partial<
  Pick<DocPageContent, "title" | "body" | "parentId" | "order" | "icon">
>;

export type CommunityDocs = {
  pages: DocPageMap;
  tree: DocTreeNode[];
  /** Tombstoned pages, newest deletion first; each can be restored. */
  deletedPages: DocPage[];
  isLoading: boolean;
  isError: boolean;
  /** The history scan hit its bound before the window ended: pages may be missing. */
  truncated: boolean;
  refetch: () => Promise<unknown>;
  createPage: (input: {
    parentId: string | null;
    title?: string;
  }) => Promise<DocPage>;
  /** Republishes `id` with `patch`; also resurrects a tombstoned page. */
  updatePage: (id: string, patch: DocPagePatch) => Promise<DocPage>;
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
 * Startup order: the live subscription on `kind:30078 #t=community-doc` is
 * opened first, and only once it is ready does the history scan run — so the
 * two overlap and nothing published in between is missed. Every fetched or
 * live version is collapsed to the newest per page id across all authors.
 * Writes sign and publish a full page event, then fold the signed copy into
 * the cache so the tree reflects the edit immediately. A socket reconnect
 * invalidates the snapshot (the live REQ carries `limit: 0` and replays no
 * history on its own).
 */
export function useCommunityDocs(): CommunityDocs {
  const queryClient = useQueryClient();
  const [subscriptionSettled, setSubscriptionSettled] = React.useState(false);

  const query = useQuery({
    queryKey: DOCS_PAGES_QUERY_KEY,
    enabled: subscriptionSettled,
    queryFn: async (): Promise<DocsSnapshot> => {
      const history = await fetchDocPagesToExhaustion({
        fetchEvents: (filter) => relayClient.fetchEvents(filter),
      });
      // Live events can land while the scan is in flight; keep whichever
      // version is newer per page rather than letting the snapshot win.
      const cached =
        queryClient.getQueryData<DocsSnapshot>(DOCS_PAGES_QUERY_KEY);
      return {
        pages: pickLatestDocPages([
          ...(cached?.pages.values() ?? []),
          ...history.pages,
        ]),
        truncated: history.truncated,
      };
    },
    staleTime: 60_000,
  });

  const applyPage = React.useCallback(
    (page: DocPage) => {
      queryClient.setQueryData<DocsSnapshot>(
        DOCS_PAGES_QUERY_KEY,
        (previous) => {
          const current = previous ?? EMPTY_SNAPSHOT;
          const pages = applyDocPageVersion(current.pages, page);
          return pages === current.pages
            ? current
            : { pages, truncated: current.truncated };
        },
      );
    },
    [queryClient],
  );

  const applyEvent = React.useCallback(
    (event: RelayEvent) => {
      const page = parseDocPageEvent(event);
      if (page) applyPage(page);
    },
    [applyPage],
  );

  React.useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    const settle = () => {
      if (!cancelled) setSubscriptionSettled(true);
    };
    relayClient
      .subscribeLive(
        {
          kinds: [KIND_COMMUNITY_DOC],
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

  const publishPage = React.useCallback(
    async (content: DocPageContent & { id: string }): Promise<DocPage> => {
      const known = readPages().get(content.id);
      const createdAt = nextDocEventCreatedAt(
        Math.floor(Date.now() / 1_000),
        known?.eventCreatedAt,
      );
      if (createdAt === null) {
        throw new DocClockSkewError(known?.eventCreatedAt ?? 0);
      }
      const event = await signRelayEvent({
        ...buildDocPageEventInput(content),
        createdAt,
      });
      const page = parseDocPageEvent(event);
      if (!page) throw new Error("Signed page event did not round-trip.");
      await relayClient.publishEvent(
        event,
        "Timed out publishing the page.",
        "Failed to publish the page.",
      );
      applyPage(page);
      return page;
    },
    [applyPage, readPages],
  );

  const createPage = React.useCallback<CommunityDocs["createPage"]>(
    async ({ parentId, title }) => {
      const now = Date.now();
      return publishPage({
        id: createDocPageId(),
        title: title?.trim() ?? "",
        body: "",
        parentId,
        order: nextOrderAfter(levelPages(tree, parentId)),
        createdAt: now,
        updatedAt: now,
      });
    },
    [publishPage, tree],
  );

  const updatePage = React.useCallback<CommunityDocs["updatePage"]>(
    async (id, patch) => {
      const current = readPages().get(id);
      if (!current) throw new Error("This page is not loaded.");
      // A tombstoned `current` is fine: the new version carries no `deleted`
      // flag and, being newer, brings the page back.
      return publishPage({
        id,
        title: current.title,
        body: current.body,
        parentId: current.parentId,
        order: current.order,
        icon: current.icon,
        createdAt: current.createdAt,
        ...patch,
        updatedAt: Date.now(),
      });
    },
    [publishPage, readPages],
  );

  const deletePage = React.useCallback<CommunityDocs["deletePage"]>(
    async (id) => {
      const current = readPages().get(id);
      if (!current || current.deleted) return;
      await publishPage({
        id,
        title: current.title,
        body: current.body,
        parentId: current.parentId,
        order: current.order,
        icon: current.icon,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        deleted: true,
      });
    },
    [publishPage, readPages],
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
      await updatePage(id, {
        parentId,
        order: nextOrderAfter(levelPages(tree, parentId)),
      });
    },
    [readPages, tree, updatePage],
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
      await updatePage(id, { order });
    },
    [tree, updatePage],
  );

  return {
    pages,
    tree,
    deletedPages,
    isLoading: query.isPending,
    isError: query.isError,
    truncated: snapshot.truncated,
    refetch: query.refetch,
    createPage,
    updatePage,
    deletePage,
    restorePage,
    movePage,
    reorderPage,
  };
}
