export type AutosaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type AutosaveTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type AutosaveScheduler<TDraft> = {
  /** Records the newest draft and restarts the debounce window. */
  schedule: (draft: TDraft) => void;
  /**
   * Saves the newest unsaved draft right away (blur, page switch, unmount).
   * Waits for an in-flight save first so drafts are never written out of
   * order. Resolves `true` when nothing is left unsaved and `false` when the
   * attempt failed (the draft stays dirty for a later retry).
   */
  flush: () => Promise<boolean>;
  /** Stops future timers and state callbacks. Does not save — flush first. */
  dispose: () => void;
  getState: () => AutosaveState;
  /** An unsaved draft exists (scheduled, or left over from a failed save). */
  isDirty: () => boolean;
  /** `isDirty`, or a save is still in flight. */
  hasPendingChanges: () => boolean;
};

const defaultTimers: AutosaveTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Debounced autosave with a durable retry posture: a failed save keeps the
 * draft dirty (state `error`) until a later flush or edit succeeds, an edit
 * made during a save is saved afterwards, and only one save runs at a time.
 */
export function createAutosaveScheduler<TDraft>({
  delayMs,
  save,
  onStateChange,
  timers = defaultTimers,
}: {
  delayMs: number;
  save: (draft: TDraft) => Promise<void>;
  onStateChange?: (state: AutosaveState) => void;
  timers?: AutosaveTimers;
}): AutosaveScheduler<TDraft> {
  let state: AutosaveState = "idle";
  let latestDraft: TDraft | undefined;
  let dirty = false;
  let disposed = false;
  let timer: unknown = null;
  let inFlight: Promise<boolean> | null = null;

  const setState = (next: AutosaveState) => {
    if (state === next) return;
    state = next;
    if (!disposed) onStateChange?.(next);
  };

  const clearTimer = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };

  const runSave = async (): Promise<boolean> => {
    const draft = latestDraft as TDraft;
    dirty = false;
    setState("saving");
    try {
      await save(draft);
      setState(dirty ? "dirty" : "saved");
      return true;
    } catch {
      dirty = true;
      setState("error");
      return false;
    }
  };

  const flush = async (): Promise<boolean> => {
    clearTimer();
    if (inFlight) await inFlight;
    if (!dirty) return true;
    inFlight = runSave().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    schedule: (draft) => {
      if (disposed) return;
      latestDraft = draft;
      dirty = true;
      if (state !== "saving") setState("dirty");
      clearTimer();
      timer = timers.setTimeout(() => {
        timer = null;
        void flush();
      }, delayMs);
    },
    flush,
    dispose: () => {
      disposed = true;
      clearTimer();
    },
    getState: () => state,
    isDirty: () => dirty,
    hasPendingChanges: () => dirty || inFlight !== null,
  };
}
