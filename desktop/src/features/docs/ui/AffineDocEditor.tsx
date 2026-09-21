import { loadDocBlob } from "../lib/docBlobStorage";
import {
  readRecovery,
  removeRecovery,
} from "../../../../../docs-editor/src/recoveryStorage";
import { parseDocDatabaseDirectiveLine } from "../lib/docDatabaseDirective";
import {
  AffineDatabasePanel,
  type AffineDatabaseSelection,
} from "./AffineDatabasePanel";
import * as React from "react";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { Button } from "@/shared/ui/button";
import {
  createAutosaveScheduler,
  type AutosaveState,
  type AutosaveScheduler,
} from "../lib/autosaveScheduler";
import { isAffineDocPayload, type DocPage } from "../lib/docPageCodec";
import { DocConflictError } from "../lib/useCommunityDocs";
import type { DocDraft, DocPageEditorHandle } from "./DocPageEditor";

const PROTOCOL = "a2d2.docs.editor.v1";
type Draft = DocDraft & { affine: NonNullable<DocPage["affine"]> };
type ScheduledDraft = Draft & { editorRevision: number };
function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.title === "string" &&
    draft.title.length <= 524288 &&
    typeof draft.body === "string" &&
    draft.body.length <= 32 * 1024 * 1024 &&
    isAffineDocPayload(draft.affine, 32 * 1024 * 1024)
  );
}
async function readBackup(key: string): Promise<Draft | null> {
  try {
    const value: unknown = JSON.parse(
      (typeof indexedDB === "undefined" ? null : await readRecovery(key)) ??
        localStorage.getItem(key) ??
        "null",
    );
    return isDraft(value) ? value : null;
  } catch {
    return null;
  }
}

/** Isolated BlockSuite frame; all signed saves stay in the existing Docs write path. */
export function AffineDocEditor({
  page,
  onSave,
  onAutosaveState,
  ref,
}: {
  page: DocPage;
  onSave: (draft: DocDraft) => Promise<void>;
  onAutosaveState: (state: AutosaveState) => void;
  ref?: React.Ref<DocPageEditorHandle>;
}) {
  const [initialPage] = React.useState(page);
  const [input, setInput] = React.useState<DocPage | (Draft & { id: string })>(
    initialPage,
  );
  const [nonce, setNonce] = React.useState(() => crypto.randomUUID());
  const [backupKey, setBackupKey] = React.useState<string | null>(null);
  const [backup, setBackup] = React.useState<Draft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const [databasePanel, setDatabasePanel] = React.useState<{
    selection: AffineDatabaseSelection | null;
  } | null>(null);
  const frame = React.useRef<HTMLIFrameElement>(null);
  const saveRef = React.useRef(onSave);
  saveRef.current = onSave;
  const stateRef = React.useRef(onAutosaveState);
  stateRef.current = onAutosaveState;
  const session = React.useRef(nonce);
  session.current = nonce;
  const savedData = React.useRef(initialPage.affine?.data);
  const discarded = React.useRef(false);
  const active = React.useRef(true);
  const pending = React.useRef(
    new Map<
      string,
      {
        resolve: (draft: ScheduledDraft) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const send = React.useCallback(
    (message: object) => {
      frame.current?.contentWindow?.postMessage(
        { protocol: PROTOCOL, nonce, ...message },
        location.origin === "null" ? "*" : location.origin,
      );
    },
    [nonce],
  );
  const capture = React.useCallback(
    () =>
      new Promise<ScheduledDraft>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.current.delete(requestId);
          reject(
            new Error(
              "The editor did not respond. Your changes have not been saved.",
            ),
          );
        }, 15000);
        pending.current.set(requestId, { resolve, reject, timer });
        send({ type: "snapshot", requestId });
      }),
    [send],
  );
  const schedulerRef = React.useRef<AutosaveScheduler<ScheduledDraft> | null>(
    null,
  );
  const createScheduler = React.useCallback(
    () =>
      createAutosaveScheduler<ScheduledDraft>({
        delayMs: 1500,
        minIntervalMs: 5000,
        onStateChange: (state) => stateRef.current(state),
        save: async (draft) => {
          if (!active.current || discarded.current)
            throw new Error("Editor is closed.");
          try {
            await saveRef.current({
              title: draft.title,
              body: draft.body,
              affine: draft.affine,
            });
            if (session.current !== nonce) return;
            savedData.current = draft.affine.data;
            send({
              type: "saved",
              revision: draft.editorRevision,
              data: draft.affine.data,
            });
            if (active.current) setError(null);
          } catch (cause) {
            if (cause instanceof DocConflictError)
              schedulerRef.current?.pause();
            if (active.current)
              setError(cause instanceof Error ? cause.message : "Save failed.");
            throw cause;
          }
        },
      }),
    [nonce, send],
  );

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([getRelayWsUrl(), getIdentity()])
      .then(async ([relay, identity]) => {
        if (cancelled) return;
        const key = `buzz.docs.affine-backup.v1.${encodeURIComponent(relay)}.${identity.pubkey}.${initialPage.id}`;
        const hydrated = await loadDocBlob(initialPage);
        const stored = await readBackup(key);
        if (cancelled) return;
        setInput(hydrated);
        savedData.current = hydrated.affine?.data;
        setBackupKey(key);
        if (stored && stored.affine.data !== hydrated.affine?.data)
          setBackup(stored);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [initialPage]);

  React.useEffect(() => {
    active.current = true;
    const scheduler = createScheduler();
    schedulerRef.current = scheduler;
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.protocol !== PROTOCOL ||
        event.data?.nonce !== nonce
      )
        return;
      const message = event.data;
      if (message.type === "ready") {
        if (backupKey) send({ type: "init", input, backupKey });
      } else if (message.type === "open-database") {
        const reference = parseDocDatabaseDirectiveLine(
          `:::db ${message.databaseId}${message.viewId === null ? "" : ` ${message.viewId}`}`,
        );
        if (
          reference &&
          typeof message.blockId === "string" &&
          message.blockId.length > 0 &&
          message.blockId.length <= 256
        )
          setDatabasePanel({
            selection: { blockId: message.blockId, ...reference },
          });
      } else if (message.type === "mounted") setMounted(true);
      else if (message.type === "dirty") stateRef.current("dirty");
      else if (message.type === "error") {
        const cause = new Error(
          typeof message.message === "string"
            ? message.message
            : "Editor failed.",
        );
        setError(cause.message);
        stateRef.current("error");
        const request = pending.current.get(message.requestId);
        if (request) {
          clearTimeout(request.timer);
          pending.current.delete(message.requestId);
          request.reject(cause);
        }
      } else if (
        message.type === "draft" &&
        isDraft(message.draft) &&
        Number.isSafeInteger(message.revision) &&
        message.revision >= 0
      ) {
        const draft = { ...message.draft, editorRevision: message.revision };
        const request = pending.current.get(message.requestId);
        if (request) {
          clearTimeout(request.timer);
          pending.current.delete(message.requestId);
          request.resolve(draft);
        }
        if (message.changed && draft.affine.data !== savedData.current) {
          try {
            scheduler.schedule(draft);
          } catch (cause) {
            setError(`Unable to keep a recovery copy: ${String(cause)}`);
            stateRef.current("error");
          }
        }
      }
    };
    window.addEventListener("message", receive);
    return () => {
      active.current = false;
      window.removeEventListener("message", receive);
      for (const request of pending.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Editor closed."));
      }
      pending.current.clear();
      // Drafts have already been mirrored locally; do not start a save after
      // unmount, when the application may have switched communities.
      scheduler.dispose();
    };
  }, [backupKey, createScheduler, input, nonce, send]);

  React.useImperativeHandle(
    ref,
    () => ({
      async flush() {
        const scheduler = schedulerRef.current;
        if (!mounted || discarded.current || !scheduler) return false;
        try {
          const draft = await capture();
          if (draft.affine.data !== savedData.current) {
            scheduler.schedule(draft);
          }
          return await scheduler.flush();
        } catch (cause) {
          setError(String(cause));
          stateRef.current("error");
          return false;
        }
      },
      discard() {
        discarded.current = true;
        schedulerRef.current?.dispose();
        if (backupKey) {
          localStorage.removeItem(backupKey);
          void removeRecovery(backupKey).catch((cause) =>
            setError(String(cause)),
          );
        }
      },
    }),
    [backupKey, capture, mounted],
  );

  return (
    <div className="flex min-h-[60vh] flex-col gap-2">
      {backup ? (
        <div className="flex items-center gap-2 rounded border p-2 text-sm">
          An unsaved structured document is available.
          <Button
            size="xs"
            onClick={() => {
              schedulerRef.current?.pause();
              setInput({ id: initialPage.id, ...backup });
              setBackup(null);
              setDatabasePanel(null);
              setMounted(false);
              setNonce(crypto.randomUUID());
            }}
          >
            Restore draft
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (backupKey) {
                localStorage.removeItem(backupKey);
                void removeRecovery(backupKey).catch((cause) =>
                  setError(String(cause)),
                );
              }
              setBackup(null);
            }}
          >
            Discard draft
          </Button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {databasePanel ? (
        <AffineDatabasePanel
          key={databasePanel.selection?.blockId ?? "picker"}
          selection={databasePanel.selection}
          onClose={() => setDatabasePanel(null)}
          onAttach={(databaseId) => {
            send({
              type: "attach-database",
              reference: { databaseId, viewId: null },
            });
            setDatabasePanel(null);
          }}
          onSelectView={(viewId) => {
            if (!databasePanel.selection) return;
            const next = { ...databasePanel.selection, viewId };
            send({
              type: "database-view",
              blockId: next.blockId,
              reference: { databaseId: next.databaseId, viewId },
            });
            setDatabasePanel({ selection: next });
          }}
        />
      ) : null}
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!mounted}
          onClick={() => setDatabasePanel({ selection: null })}
        >
          Link database
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!mounted}
          onClick={() => send({ type: "mode", mode: "page" })}
        >
          Document
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!mounted}
          onClick={() => send({ type: "mode", mode: "edgeless" })}
        >
          Whiteboard
        </Button>
      </div>
      {backupKey && !backup ? (
        <iframe
          key={nonce}
          ref={frame}
          title="AFFiNE document editor"
          className="h-[70vh] w-full border-0"
          src={`${import.meta.env?.BASE_URL ?? "/"}docs-editor/index.html#${nonce}`}
        />
      ) : (
        <p role="status">Preparing editor…</p>
      )}
    </div>
  );
}
