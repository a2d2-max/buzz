import { EditorContent } from "@tiptap/react";
import * as React from "react";

import { useRichTextEditor } from "@/features/messages/lib/useRichTextEditor";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import {
  type AutosaveState,
  createAutosaveScheduler,
} from "../lib/autosaveScheduler";
import {
  clearDocDraftBackup,
  type DocDraftBackup,
  readDocDraftBackup,
  writeDocDraftBackup,
} from "../lib/docDraftBackup";
import { DocImageNode } from "../lib/docImageNode";
import type { DocPage } from "../lib/docPageCodec";
import {
  compareRenderedMarkdown,
  scanUnsupportedMarkdown,
} from "../lib/markdownFidelity";

export const DOC_AUTOSAVE_DELAY_MS = 1_500;

export type DocDraft = { title: string; body: string };

/** `rich` is the TipTap document; `source` is the raw markdown in a textarea. */
export type DocEditorMode = "rich" | "source";

export type DocPageEditorHandle = {
  /** Saves pending edits now; resolves `false` when the save failed. */
  flush: () => Promise<boolean>;
  /** Drops pending edits so unmount does not publish them. */
  discard: () => void;
};

type DocPageEditorProps = {
  autoFocus?: boolean;
  onAutosaveState: (state: AutosaveState) => void;
  onSave: (draft: DocDraft) => Promise<void>;
  page: DocPage;
  ref?: React.Ref<DocPageEditorHandle>;
};

const DOC_EDITOR_EXTENSIONS = [DocImageNode];

/**
 * Heading/list/code rhythm for the contenteditable, mirroring the read view.
 * The `.ProseMirror` size rule outranks the chat-sized `text-message` class
 * the shared hook puts on the element.
 */
const DOC_EDITOR_PROSE_CLASS = cn(
  "doc-editor min-h-[50vh] leading-7",
  "[&_.ProseMirror]:min-h-[50vh] [&_.ProseMirror]:text-base [&_.ProseMirror]:outline-none",
  "[&_h1]:mb-2 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-base [&_h4]:font-semibold",
  "[&_h5]:mt-3 [&_h5]:text-sm [&_h5]:font-semibold [&_h6]:mt-3 [&_h6]:text-sm [&_h6]:font-semibold [&_h6]:text-muted-foreground",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
);

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function formatBackupTime(unixMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(unixMs));
}

function describeLossyReasons(reasons: string[]): string {
  const known = reasons.filter((reason) => /^[a-z ]+$/i.test(reason));
  return known.length > 0 ? known.join(", ") : "formatting";
}

/**
 * Title + body editor with debounced autosave.
 *
 * The body opens in the rich editor unless the page uses constructs TipTap
 * cannot carry (tables, footnotes, task lists, raw HTML — checked by syntax
 * scan and by comparing the parser's rendering of the source against the
 * editor's echo), in which case it opens as raw markdown so the first
 * autosave cannot flatten the page. Edits save after
 * {@link DOC_AUTOSAVE_DELAY_MS} of quiet, on blur, and on unmount; a failed
 * save keeps the draft pending and mirrors it to localStorage so it can be
 * offered back the next time the page opens.
 */
export function DocPageEditor({
  autoFocus = false,
  onAutosaveState,
  onSave,
  page,
  ref,
}: DocPageEditorProps) {
  const [title, setTitle] = React.useState(page.title);
  const titleRef = React.useRef(title);
  titleRef.current = title;
  const [mode, setMode] = React.useState<DocEditorMode>(() =>
    scanUnsupportedMarkdown(page.body).length > 0 ? "source" : "rich",
  );
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  const [lossyReasons, setLossyReasons] = React.useState<string[]>(() =>
    scanUnsupportedMarkdown(page.body),
  );
  const [sourceBody, setSourceBody] = React.useState(page.body);
  const sourceBodyRef = React.useRef(sourceBody);
  sourceBodyRef.current = sourceBody;
  const [backup, setBackup] = React.useState<DocDraftBackup | null>(() => {
    const stored = readDocDraftBackup(safeLocalStorage(), page.id);
    return stored && (stored.body !== page.body || stored.title !== page.title)
      ? stored
      : null;
  });
  const onSaveRef = React.useRef(onSave);
  onSaveRef.current = onSave;
  const onAutosaveStateRef = React.useRef(onAutosaveState);
  onAutosaveStateRef.current = onAutosaveState;
  const getMarkdownRef = React.useRef<() => string>(() => page.body);
  // TipTap's setContent emits `update` like a keystroke would; loading content
  // must not look like an edit or an identical copy gets republished.
  const loadingContentRef = React.useRef(false);
  const discardedRef = React.useRef(false);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const sourceInputRef = React.useRef<HTMLTextAreaElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const currentBody = React.useCallback(
    () =>
      modeRef.current === "source"
        ? sourceBodyRef.current
        : getMarkdownRef.current(),
    [],
  );

  // Drafts are thunks so markdown serialization runs once per save, not once
  // per keystroke. A failed publish leaves a durable copy behind.
  const scheduler = React.useMemo(
    () =>
      createAutosaveScheduler<() => DocDraft>({
        delayMs: DOC_AUTOSAVE_DELAY_MS,
        onStateChange: (state) => onAutosaveStateRef.current(state),
        save: async (draft) => {
          const materialized = draft();
          try {
            await onSaveRef.current(materialized);
            clearDocDraftBackup(safeLocalStorage(), page.id);
          } catch (error) {
            writeDocDraftBackup(safeLocalStorage(), page.id, {
              ...materialized,
              savedAt: Date.now(),
            });
            throw error;
          }
        },
      }),
    [page.id],
  );

  const scheduleSave = React.useCallback(() => {
    scheduler.schedule(() => ({
      title: titleRef.current,
      body: currentBody(),
    }));
  }, [currentBody, scheduler]);

  const richText = useRichTextEditor({
    documentMode: true,
    extraExtensions: DOC_EDITOR_EXTENSIONS,
    onUpdate: () => {
      if (!loadingContentRef.current && modeRef.current === "rich") {
        scheduleSave();
      }
    },
    placeholder:
      "Write something… Markdown works: # headings, - lists, ```code",
  });
  getMarkdownRef.current = richText.getMarkdown;
  const { editor, focusEnd, getMarkdown, setContent } = richText;

  const loadIntoRichEditor = React.useCallback(
    (markdown: string) => {
      loadingContentRef.current = true;
      try {
        setContent(markdown);
      } finally {
        loadingContentRef.current = false;
      }
    },
    [setContent],
  );

  /**
   * Loads `markdown` into the rich editor and reports what it cannot keep —
   * empty means faithful. Both the source and the editor's echo go through
   * the parser TipTap itself uses, so the comparison sees exactly what the
   * next save would write.
   */
  const assessRichFidelity = React.useCallback(
    (markdown: string): string[] => {
      const syntax = scanUnsupportedMarkdown(markdown);
      if (syntax.length > 0 || !editor) return syntax;
      loadIntoRichEditor(markdown);
      if (markdown.trim() === "") return [];
      // biome-ignore lint/suspicious/noExplicitAny: tiptap-markdown storage is untyped
      const parser = (editor.storage as any).markdown?.parser as
        | { parse?: (source: string) => string }
        | undefined;
      if (!parser?.parse) return [];
      const verdict = compareRenderedMarkdown(
        parser.parse(markdown),
        parser.parse(getMarkdown()),
      );
      return verdict.faithful ? [] : verdict.reasons;
    },
    [editor, getMarkdown, loadIntoRichEditor],
  );

  const loadedRef = React.useRef(false);
  React.useEffect(() => {
    if (!editor || loadedRef.current) return;
    loadedRef.current = true;
    // The shared hook labels its element as the chat input.
    editor.view.dom.setAttribute("data-testid", "doc-body-input");
    if (modeRef.current === "rich") {
      const reasons = assessRichFidelity(page.body);
      if (reasons.length > 0) {
        setLossyReasons(reasons);
        setMode("source");
      }
    }
    if (!autoFocus) return;
    if (page.title.trim() === "") titleInputRef.current?.focus();
    else if (modeRef.current === "rich") focusEnd();
    else sourceInputRef.current?.focus();
  }, [assessRichFidelity, autoFocus, editor, focusEnd, page.body, page.title]);

  const switchMode = React.useCallback(
    (next: DocEditorMode) => {
      if (next === modeRef.current) return;
      if (next === "source") {
        const markdown = getMarkdownRef.current();
        sourceBodyRef.current = markdown;
        setSourceBody(markdown);
        setMode("source");
        return;
      }
      const reasons = assessRichFidelity(sourceBodyRef.current);
      setLossyReasons(reasons);
      if (reasons.length === 0) setMode("rich");
    },
    [assessRichFidelity],
  );

  const applyDraft = React.useCallback(
    (draft: DocDraft) => {
      setTitle(draft.title);
      titleRef.current = draft.title;
      sourceBodyRef.current = draft.body;
      setSourceBody(draft.body);
      if (modeRef.current === "rich") {
        const reasons = assessRichFidelity(draft.body);
        if (reasons.length > 0) {
          setLossyReasons(reasons);
          setMode("source");
        }
      }
      scheduleSave();
    },
    [assessRichFidelity, scheduleSave],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      flush: () => scheduler.flush(),
      discard: () => {
        discardedRef.current = true;
        scheduler.dispose();
      },
    }),
    [scheduler],
  );

  React.useEffect(
    () => () => {
      if (discardedRef.current) {
        scheduler.dispose();
        return;
      }
      // Unmount (page switch, leaving Docs): push pending edits out first.
      // TipTap destroys the editor on the next tick, so serializing here still
      // sees the live document — materialize the draft now instead of inside
      // a save that may run after that tick.
      if (scheduler.isDirty()) {
        const snapshot: DocDraft = {
          title: titleRef.current,
          body: currentBody(),
        };
        scheduler.schedule(() => snapshot);
      }
      void scheduler.flush();
      scheduler.dispose();
    },
    [currentBody, scheduler],
  );

  // Blur = "I'm done for now": save unless focus merely moved within the editor.
  const handleBlur = React.useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && containerRef.current?.contains(next)) return;
      void scheduler.flush();
    },
    [scheduler],
  );

  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-3"
      data-testid="doc-editor"
      ref={containerRef}
    >
      {backup ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
          data-testid="doc-draft-backup"
          role="status"
        >
          <span>
            An unsaved draft from {formatBackupTime(backup.savedAt)} was
            recovered.
          </span>
          <Button
            onClick={() => {
              applyDraft({ body: backup.body, title: backup.title });
              setBackup(null);
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            Restore draft
          </Button>
          <Button
            onClick={() => {
              clearDocDraftBackup(safeLocalStorage(), page.id);
              setBackup(null);
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            Discard it
          </Button>
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <input
          aria-label="Page title"
          className="w-full min-w-0 bg-transparent text-3xl font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/60"
          data-testid="doc-title-input"
          onBlur={handleBlur}
          onChange={(event) => {
            setTitle(event.target.value);
            titleRef.current = event.target.value;
            scheduleSave();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (modeRef.current === "rich") focusEnd();
            else sourceInputRef.current?.focus();
          }}
          placeholder="Untitled"
          ref={titleInputRef}
          spellCheck
          type="text"
          value={title}
        />
        <fieldset className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 p-0.5">
          <legend className="sr-only">Editor mode</legend>
          <Button
            aria-pressed={mode === "rich"}
            onClick={() => switchMode("rich")}
            size="xs"
            type="button"
            variant={mode === "rich" ? "secondary" : "ghost"}
          >
            Rich text
          </Button>
          <Button
            aria-pressed={mode === "source"}
            onClick={() => switchMode("source")}
            size="xs"
            type="button"
            variant={mode === "source" ? "secondary" : "ghost"}
          >
            Markdown
          </Button>
        </fieldset>
      </div>
      {lossyReasons.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="doc-editor-lossy-notice"
          role="status"
        >
          Editing as Markdown: this page uses{" "}
          {describeLossyReasons(lossyReasons)} that the rich editor cannot keep.
        </p>
      ) : null}
      {mode === "rich" ? (
        <div className={DOC_EDITOR_PROSE_CLASS}>
          <EditorContent editor={editor} onBlur={handleBlur} />
        </div>
      ) : (
        <textarea
          aria-label="Page body (Markdown)"
          className="min-h-[50vh] w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 font-mono text-sm leading-6 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="doc-source-input"
          onBlur={handleBlur}
          onChange={(event) => {
            setSourceBody(event.target.value);
            sourceBodyRef.current = event.target.value;
            scheduleSave();
          }}
          ref={sourceInputRef}
          spellCheck={false}
          value={sourceBody}
        />
      )}
    </div>
  );
}
