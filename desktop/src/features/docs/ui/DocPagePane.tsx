import { loadDocBlob } from "../lib/docBlobStorage";
import { Check, Pencil, Plus, RotateCcw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

import type { AutosaveState } from "../lib/autosaveScheduler";
import type { DocPage } from "../lib/docPageCodec";
import {
  type DocDraft,
  DocPageEditor,
  type DocPageEditorHandle,
} from "./DocPageEditor";
import { docPageLabel } from "./DocsTree";
import { DocDatabaseReadBlock } from "./DocDatabaseBlock";

type DocPagePaneProps = {
  /** Root-to-parent chain, excluding the page itself. */
  ancestors: DocPage[];
  onCreateChild: (parentId: string) => void;
  onNavigate: (id: string | null) => void;
  onRestore: (id: string) => Promise<unknown>;
  /**
   * Publishes the draft on top of `baseEventId`, the version the editor was
   * loaded from; rejects with a conflict when the relay holds a newer one.
   */
  onSave: (
    id: string,
    draft: DocDraft,
    baseEventId: string,
  ) => Promise<DocPage>;
  page: DocPage;
};

const SAVE_STATUS_LABEL: Record<AutosaveState, string> = {
  idle: "",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

function formatEditedAt(unixMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(unixMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The relay did not accept the page.";
}

/**
 * Right-hand pane: breadcrumb header, then either the rendered page or the
 * editor. Edit mode loads one page version; a newer version arriving from
 * someone else is surfaced as a banner rather than silently replacing the
 * draft under the caret, and "Done" refuses to leave the editor while a save
 * is still failing.
 */
export function DocPagePane({
  ancestors,
  onCreateChild,
  onNavigate,
  onRestore,
  onSave,
  page,
}: DocPagePaneProps) {
  const [mode, setMode] = React.useState<"view" | "edit">(() =>
    !page.deleted && page.body.trim() === "" ? "edit" : "view",
  );
  const [structured, setStructured] = React.useState(
    !!page.affine || (!page.deleted && page.body.trim() === ""),
  );
  const [loadedBody, setLoadedBody] = React.useState<{
    eventId: string;
    body?: string;
    error?: string;
  } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    if (page.affine?.version === 3)
      void loadDocBlob(page).then(
        (value) => {
          if (!cancelled)
            setLoadedBody({ eventId: page.eventId, body: value.body });
        },
        (cause) => {
          if (!cancelled)
            setLoadedBody({ eventId: page.eventId, error: String(cause) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [page]);
  const viewBody =
    page.affine?.version === 3
      ? loadedBody?.eventId === page.eventId
        ? loadedBody.body
        : undefined
      : page.body;

  const [saveState, setSaveState] = React.useState<AutosaveState>("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // Event id the editor's content is based on; bumps after every own save.
  // The ref is the value a save reads, so a rebase applies to the very next
  // flush without waiting for a render.
  const [baseEventId, setBaseEventIdState] = React.useState(page.eventId);
  const baseEventIdRef = React.useRef(baseEventId);
  const setBaseEventId = React.useCallback((eventId: string) => {
    baseEventIdRef.current = eventId;
    setBaseEventIdState(eventId);
  }, []);
  // "Keep mine" hides the banner for exactly this remote version.
  const [dismissedEventId, setDismissedEventId] = React.useState<string | null>(
    null,
  );
  // Bumped to remount the editor on a fresh version.
  const [editorSession, setEditorSession] = React.useState(0);
  const [isRestoring, setIsRestoring] = React.useState(false);
  const editorRef = React.useRef<DocPageEditorHandle>(null);
  const label = docPageLabel(page);
  const remoteChanged =
    mode === "edit" &&
    page.eventId !== baseEventId &&
    page.eventId !== dismissedEventId;
  const renderDocDatabase = React.useCallback(
    (databaseId: string, viewId: string | null) => (
      <DocDatabaseReadBlock databaseId={databaseId} viewId={viewId} />
    ),
    [],
  );

  const handleSave = React.useCallback(
    async (draft: DocDraft) => {
      try {
        const saved = await onSave(page.id, draft, baseEventIdRef.current);
        setSaveError(null);
        setBaseEventId(saved.eventId);
      } catch (error) {
        // A conflict has already put the newer version into the cache, so
        // `page.eventId` moves and the banner below offers the two ways out.
        setSaveError(errorMessage(error));
        throw error;
      }
    },
    [onSave, page.id, setBaseEventId],
  );

  /** "Keep mine": rebase the draft onto the version that beat it, then save over it. */
  const overwriteRemoteVersion = React.useCallback(() => {
    setBaseEventId(page.eventId);
    setDismissedEventId(page.eventId);
    setSaveError(null);
    void editorRef.current?.flush();
  }, [page.eventId, setBaseEventId]);

  const enterEdit = React.useCallback(() => {
    setBaseEventId(page.eventId);
    setDismissedEventId(null);
    setEditorSession((session) => session + 1);
    setSaveState("idle");
    setSaveError(null);
    setMode("edit");
  }, [page.eventId, setBaseEventId]);

  const finishEdit = React.useCallback(async () => {
    const saved = await editorRef.current?.flush();
    if (saved === false) {
      toast.error("Couldn't save the page. Your changes are still here.");
      return;
    }
    setMode("view");
  }, []);

  const loadRemoteVersion = React.useCallback(() => {
    // The old editor must not publish its draft on the way out — that would
    // overwrite the very version we are loading.
    editorRef.current?.discard();
    setBaseEventId(page.eventId);
    setDismissedEventId(null);
    setEditorSession((session) => session + 1);
    setSaveState("idle");
    setSaveError(null);
  }, [page.eventId, setBaseEventId]);

  const discardEdits = React.useCallback(() => {
    editorRef.current?.discard();
    setMode("view");
    setSaveState("idle");
    setSaveError(null);
  }, []);

  const restorePage = React.useCallback(async () => {
    setIsRestoring(true);
    try {
      await onRestore(page.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setIsRestoring(false);
    }
  }, [onRestore, page.id]);

  const statusLabel =
    mode === "edit"
      ? saveState === "error" && saveError
        ? `Save failed: ${saveError}`
        : SAVE_STATUS_LABEL[saveState]
      : "";

  if (page.structuredMergeConflict)
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <h1 className="text-2xl font-semibold">{label}</h1>
        <p role="alert">
          Concurrent structured changes could not be combined safely. This
          preview is read-only so no branch is overwritten.
        </p>
        <Markdown blockCode content={page.body} />
      </div>
    );
  if (page.unsupportedEditor)
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <h1 className="text-2xl font-semibold">{label}</h1>
        <p role="alert">
          This page uses an unsupported editor format. Update a2d2 to edit it.
          Its preview is read-only.
        </p>
        <Markdown blockCode content={page.body} />
      </div>
    );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="doc-page-pane"
    >
      <TopChromeInsetHeader flush>
        <div className="flex min-h-9 items-center gap-2 px-4 py-2">
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted-foreground"
          >
            <button
              className="shrink-0 hover:text-foreground"
              onClick={() => onNavigate(null)}
              type="button"
            >
              Docs
            </button>
            {ancestors.map((ancestor) => (
              <React.Fragment key={ancestor.id}>
                <span aria-hidden="true">/</span>
                <button
                  className="min-w-0 truncate hover:text-foreground"
                  onClick={() => onNavigate(ancestor.id)}
                  type="button"
                >
                  {docPageLabel(ancestor)}
                </button>
              </React.Fragment>
            ))}
            <span aria-hidden="true">/</span>
            <span
              aria-current="page"
              className="min-w-0 truncate text-foreground"
            >
              {label}
            </span>
          </nav>
          <span
            aria-live="polite"
            className={cn(
              "min-w-0 shrink truncate text-xs",
              saveState === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
            data-testid="doc-save-status"
            role="status"
            title={statusLabel}
          >
            {statusLabel}
          </span>
          {mode === "edit" && saveState === "error" ? (
            <Button
              onClick={() => void editorRef.current?.flush()}
              size="xs"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          ) : null}
          {mode === "view" && !page.deleted && !page.affine ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => {
                setStructured(true);
                enterEdit();
              }}
            >
              Open in AFFiNE
            </Button>
          ) : null}
          {mode === "edit" ? (
            <Button
              data-testid="doc-finish-edit"
              onClick={() => void finishEdit()}
              size="sm"
              type="button"
            >
              <Check /> Done
            </Button>
          ) : page.deleted ? null : (
            <Button
              data-testid="doc-start-edit"
              onClick={enterEdit}
              size="sm"
              type="button"
              variant="outline"
            >
              <Pencil /> Edit
            </Button>
          )}
          {page.deleted ? null : (
            <Button
              aria-label="Add a sub-page"
              onClick={() => onCreateChild(page.id)}
              size="icon"
              title="Add a sub-page"
              type="button"
              variant="ghost"
            >
              <Plus />
            </Button>
          )}
        </div>
      </TopChromeInsetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-6">
          {mode === "edit" && page.deleted ? (
            <div
              className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
              role="status"
            >
              <span>
                Someone deleted this page while you were editing. Saving brings
                it back with your edits.
              </span>
              <Button
                onClick={overwriteRemoteVersion}
                size="xs"
                type="button"
                variant="outline"
              >
                Restore with my edits
              </Button>
              <Button
                onClick={discardEdits}
                size="xs"
                type="button"
                variant="ghost"
              >
                Discard my edits
              </Button>
            </div>
          ) : null}
          {remoteChanged && !page.deleted ? (
            <div
              className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
              data-testid="doc-remote-change"
              role="status"
            >
              <span>
                Someone else updated this page while you were editing.
              </span>
              <Button
                onClick={loadRemoteVersion}
                size="xs"
                type="button"
                variant="outline"
              >
                Load their version
              </Button>
              <Button
                onClick={overwriteRemoteVersion}
                size="xs"
                type="button"
                variant="ghost"
              >
                Keep mine
              </Button>
              <span className="text-xs text-muted-foreground">
                Loading theirs drops your unsaved edits; keeping yours
                overwrites their version.
              </span>
            </div>
          ) : null}
          {mode === "edit" ? (
            <DocPageEditor
              structured={structured || !!page.affine}
              autoFocus
              key={`${page.id}:${editorSession}`}
              onAutosaveState={setSaveState}
              onSave={handleSave}
              page={page}
              ref={editorRef}
            />
          ) : page.deleted ? (
            <div
              className="flex flex-col items-start gap-3 text-sm text-muted-foreground"
              data-testid="doc-page-deleted"
            >
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {label}
              </h1>
              <p>
                This page was deleted {formatEditedAt(page.updatedAt)}. Its
                content is kept and can be restored.
              </p>
              <Button
                disabled={isRestoring}
                onClick={() => void restorePage()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RotateCcw /> Restore page
              </Button>
            </div>
          ) : (
            <article data-testid="doc-page-view">
              <h1 className="text-3xl font-semibold tracking-tight">
                {page.icon ? (
                  <span aria-hidden="true" className="mr-2">
                    {page.icon}
                  </span>
                ) : null}
                {label}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Edited {formatEditedAt(page.updatedAt)} ·{" "}
                {page.author.slice(0, 8)}
              </p>
              <div className="mt-6 text-base leading-7">
                {viewBody === undefined ? (
                  <p role={loadedBody?.error ? "alert" : "status"}>
                    {loadedBody?.eventId === page.eventId && loadedBody.error
                      ? loadedBody.error
                      : "Loading complete document…"}
                  </p>
                ) : viewBody.trim() ? (
                  <Markdown
                    blockCode
                    content={viewBody}
                    docsDatabases
                    renderDocDatabase={renderDocDatabase}
                  />
                ) : (
                  <p className="text-muted-foreground">
                    This page is empty.{" "}
                    <button
                      className="text-primary underline underline-offset-4"
                      onClick={enterEdit}
                      type="button"
                    >
                      Start writing
                    </button>
                  </p>
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
