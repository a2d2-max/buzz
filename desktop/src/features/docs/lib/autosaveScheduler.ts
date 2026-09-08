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
  /**
   * Stops the debounce timer until `resume()` or the next successful save.
   * Drafts are still recorded and `flush()` still works — this only stops
   * automatic retries while a conflict waits on the user.
   */
  pause: () => void;
  resume: () => void;
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
 * `minIntervalMs` spaces automatic saves out (a burst of pauses while typing
 * must not become a burst of publishes); an explicit `flush()` ignores it.
 */
export function createAutosaveScheduler<TDraft>({
  delayMs,
  minIntervalMs = 0,
  now = () => Date.now(),
  save,
  onStateChange,
  timers = defaultTimers,
}: {
  delayMs: number;
  minIntervalMs?: number;
  now?: () => number;
  save: (draft: TDraft) => Promise<void>;
  onStateChange?: (state: AutosaveState) => void;
  timers?: AutosaveTimers;
}): AutosaveScheduler<TDraft> {
  let state: AutosaveState = "idle";
  let latestDraft: TDraft | undefined;
  let dirty = false;
  let disposed = false;
  let paused = false;
  let timer: unknown = null;
  let inFlight: Promise<boolean> | null = null;
  let lastSaveFinishedAt: number | null = null;

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
      paused = false;
      setState(dirty ? "dirty" : "saved");
      return true;
    } catch {
      dirty = true;
      setState("error");
      return false;
    } finally {
      lastSaveFinishedAt = now();
    }
  };

  const startTimer = () => {
    clearTimer();
    const sinceLastSave =
      lastSaveFinishedAt === null
        ? Number.POSITIVE_INFINITY
        : now() - lastSaveFinishedAt;
    const delay = Math.max(delayMs, minIntervalMs - sinceLastSave);
    timer = timers.setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
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
      if (paused) {
        clearTimer();
        return;
      }
      startTimer();
    },
    flush,
    pause: () => {
      paused = true;
      clearTimer();
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      if (dirty && !disposed) startTimer();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
    },
    getState: () => state,
    isDirty: () => dirty,
    hasPendingChanges: () => dirty || inFlight !== null,
  };
}
