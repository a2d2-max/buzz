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
    movePage,
    reorderPage,
    restorePage,
    updatePage,
  } = docs;
  const { goDocs } = useAppNavigation();

  // Tombstoned pages stay reachable by URL so they can be restored.
  const selected = (pageId ? docs.pages.get(pageId) : undefined) ?? null;
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
    (id: string, draft: DocDraft) =>
      updatePage(id, { body: draft.body, title: draft.title }),
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
              load can scan.{" "}
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
            isError={docs.isError}
            isLoading={docs.isLoading}
            missingPage={Boolean(pageId) && !docs.isLoading}
            onBack={() => navigate(null)}
            onCreate={() => void handleCreate(null)}
            onRetry={() => void docs.refetch()}
          />
        )}
      </section>
    </div>
  );
}

function DocsPlaceholder({
  isError,
  isLoading,
  missingPage,
  onBack,
  onCreate,
  onRetry,
}: {
  isError: boolean;
  isLoading: boolean;
  missingPage: boolean;
  onBack: () => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  if (isLoading) {
    return <BuzzLoadingState fill label="Loading docs" />;
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
          <p>This page doesn't exist or was deleted.</p>
          <Button onClick={onBack} size="sm" type="button" variant="outline">
            Back to Docs
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
