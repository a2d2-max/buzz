import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { AlertTriangle, BookOpen, Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { Button } from "@/shared/ui/button";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

import { findDocTreePath } from "../lib/docTree";
import { useCommunityDocs } from "../lib/useCommunityDocs";
import type { DocDraft } from "./DocPageEditor";
import { DocPagePane } from "./DocPagePane";
import { DocsTree } from "./DocsTree";

type DocsScreenProps = {
  /** Page selected by the route; undefined on the bare `/docs` overview. */
  pageId?: string;
};

function reportFailure(message: string, error: unknown) {
  console.warn(`[docs] ${message}`, error);
  toast.error(message);
}

export function DocsScreen({ pageId }: DocsScreenProps) {
  const docs = useCommunityDocs();
  const {
    createPage,
    deletePage,
    lookupPage,
    movePage,
    reorderPage,
    restorePage,
    updatePage,
  } = docs;
  const { goDocs } = useAppNavigation();
  // A link inside a page can point at a page the relay does not hold; the
  // notice must lead back to where that link was, not to the overview.
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const goBack = React.useCallback(() => router.history.back(), [router]);

  // Tombstoned pages stay reachable by URL so they can be restored.
  const selected = (pageId ? docs.pages.get(pageId) : undefined) ?? null;

  // A deep link to a page the history scan did not deliver (truncated window,
  // or the page is newer than the cache) gets one authoritative `#d` lookup
  // before the screen is allowed to say the page does not exist. "The relay
  // did not answer" is kept apart from "the relay has no such page".
  const [lookup, setLookup] = React.useState<{
    pageId: string;
    status: "answered" | "failed";
  } | null>(null);
  const lookupSettled =
    lookup !== null && lookup.pageId === pageId ? lookup.status : null;
  const needsLookup =
    Boolean(pageId) && !docs.isLoading && !selected && lookupSettled === null;
  React.useEffect(() => {
    if (!needsLookup || !pageId) return;
    let cancelled = false;
    lookupPage(pageId).then(
      () => {
        if (!cancelled) setLookup({ pageId, status: "answered" });
      },
      (error: unknown) => {
        console.warn("[docs] page lookup failed", error);
        if (!cancelled) setLookup({ pageId, status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [lookupPage, needsLookup, pageId]);
  const retryLookup = React.useCallback(() => setLookup(null), []);
  const ancestors = React.useMemo(
    () => (pageId ? findDocTreePath(docs.tree, pageId).slice(0, -1) : []),
    [docs.tree, pageId],
  );

  const navigate = React.useCallback(
    (id: string | null) => {
      void goDocs(id);
    },
    [goDocs],
  );

  const handleCreate = React.useCallback(
    async (parentId: string | null) => {
      try {
        const page = await createPage({ parentId });
        await goDocs(page.id);
      } catch (error) {
        reportFailure("Couldn't create the page.", error);
      }
    },
    [createPage, goDocs],
  );

  const handleDelete = React.useCallback(
    async (id: string) => {
      try {
        await deletePage(id);
        if (id === pageId) await goDocs(null);
      } catch (error) {
        reportFailure("Couldn't delete the page.", error);
      }
    },
    [deletePage, goDocs, pageId],
  );

  const handleMove = React.useCallback(
    async (id: string, parentId: string | null) => {
      try {
        await movePage(id, parentId);
      } catch (error) {
        reportFailure(
          error instanceof Error ? error.message : "Couldn't move the page.",
          error,
        );
      }
    },
    [movePage],
  );

  const handleReorder = React.useCallback(
    async (id: string, direction: -1 | 1) => {
      try {
        await reorderPage(id, direction);
      } catch (error) {
        reportFailure("Couldn't reorder the page.", error);
      }
    },
    [reorderPage],
  );

  const handleSave = React.useCallback(
    (id: string, draft: DocDraft, baseEventId: string) =>
      updatePage(id, { body: draft.body, title: draft.title }, { baseEventId }),
    [updatePage],
  );

  const handleRestore = React.useCallback(
    async (id: string) => {
      try {
        await restorePage(id);
      } catch (error) {
        reportFailure("Couldn't restore the page.", error);
        throw error;
      }
    },
    [restorePage],
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
      data-testid="docs-screen"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/60">
        <TopChromeInsetHeader flush>
          <div className="flex min-h-9 items-center gap-2 px-4 py-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Docs</span>
          </div>
        </TopChromeInsetHeader>
        {docs.truncated ? (
          <div
            className="mx-3 mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-foreground"
            data-testid="docs-truncated"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>
              Some pages may be missing: the relay holds more history than one
              load can scan ({docs.scanned.toLocaleString()} rows checked).{" "}
              <button
                className="underline underline-offset-2"
                onClick={() => void docs.refetch()}
                type="button"
              >
                Reload
              </button>
            </span>
          </div>
        ) : null}
        <DocsTree
          deletedPages={docs.deletedPages}
          isLoading={docs.isLoading}
          onCreate={(parentId) => void handleCreate(parentId)}
          onDelete={(id) => void handleDelete(id)}
          onMove={(id, parentId) => void handleMove(id, parentId)}
          onReorder={(id, direction) => void handleReorder(id, direction)}
          onRestore={(id) => void handleRestore(id).catch(() => undefined)}
          onSelect={navigate}
          selectedId={selected?.id ?? null}
          tree={docs.tree}
        />
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {selected ? (
          <DocPagePane
            ancestors={ancestors}
            key={selected.id}
            onCreateChild={(parentId) => void handleCreate(parentId)}
            onNavigate={navigate}
            onRestore={handleRestore}
            onSave={handleSave}
            page={selected}
          />
        ) : (
          <DocsPlaceholder
            backLabel={canGoBack ? "Go back" : "Back to Docs"}
            isError={docs.isError}
            isLoading={docs.isLoading || needsLookup}
            lookupFailed={lookupSettled === "failed"}
            missingPage={lookupSettled === "answered"}
            onBack={canGoBack ? goBack : () => navigate(null)}
            onCreate={() => void handleCreate(null)}
            onRetry={() => void docs.refetch()}
            onRetryLookup={retryLookup}
            pageId={pageId ?? null}
          />
        )}
      </section>
    </div>
  );
}

function DocsPlaceholder({
  backLabel,
  isError,
  isLoading,
  lookupFailed,
  missingPage,
  onBack,
  onCreate,
  onRetry,
  onRetryLookup,
  pageId,
}: {
  backLabel: string;
  isError: boolean;
  isLoading: boolean;
  lookupFailed: boolean;
  missingPage: boolean;
  onBack: () => void;
  onCreate: () => void;
  onRetry: () => void;
  onRetryLookup: () => void;
  pageId: string | null;
}) {
  if (isLoading) {
    return <BuzzLoadingState fill label="Loading docs" />;
  }
  if (lookupFailed) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground"
        data-testid="docs-placeholder"
      >
        <p>Couldn't check the relay for this page.</p>
        <Button
          onClick={onRetryLookup}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground"
      data-testid="docs-placeholder"
    >
      {isError ? (
        <>
          <p>Couldn't load the community docs.</p>
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Try again
          </Button>
        </>
      ) : missingPage ? (
        <>
          <p>
            {pageId ? `Page "${pageId}"` : "This page"} doesn't exist or was
            deleted.
          </p>
          <Button onClick={onBack} size="sm" type="button" variant="outline">
            {backLabel}
          </Button>
        </>
      ) : (
        <>
          <BookOpen className="h-8 w-8 text-muted-foreground/60" />
          <p>Pick a page on the left, or start a new one.</p>
          <Button onClick={onCreate} size="sm" type="button">
            <Plus /> New page
          </Button>
        </>
      )}
    </div>
  );
}
