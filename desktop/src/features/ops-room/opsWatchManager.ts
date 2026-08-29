import { listen } from "@tauri-apps/api/event";

import { startOpsWatch } from "./opsBridge";

export interface OpsInvalidationPayload {
  full_reload?: boolean;
  setup_refresh?: boolean;
}

type Subscriber = (payload: OpsInvalidationPayload) => void;

const OPS_INVALIDATED_EVENT = "buzz://ops-invalidated";
const subscribers = new Set<Subscriber>();
let setupPromise: Promise<void> | null = null;
let stopListener: (() => void) | null = null;
let generation = 0;
let teardownTicket = 0;
let nativeWatchStarted = false;

function broadcast(payload: OpsInvalidationPayload): void {
  for (const subscriber of subscribers) subscriber(payload);
}

async function setup(expectedGeneration: number): Promise<void> {
  const stop = await listen<OpsInvalidationPayload>(
    OPS_INVALIDATED_EVENT,
    (event) => broadcast(event.payload ?? {}),
  );
  if (expectedGeneration !== generation || subscribers.size === 0) {
    void stop();
    return;
  }

  try {
    if (!nativeWatchStarted) {
      await startOpsWatch();
      nativeWatchStarted = true;
    }
  } catch (error) {
    void stop();
    throw error;
  }

  if (expectedGeneration !== generation || subscribers.size === 0) {
    void stop();
    return;
  }
  stopListener = () => void stop();
  broadcast({ setup_refresh: true });
}

export async function ensureOpsWatchManager(): Promise<void> {
  if (stopListener) return;
  if (setupPromise) return setupPromise;

  const expectedGeneration = generation;
  const pending = setup(expectedGeneration);
  setupPromise = pending;
  try {
    await pending;
  } finally {
    if (setupPromise === pending) setupPromise = null;
  }
}

export function subscribeOpsInvalidations(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  teardownTicket += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(subscriber);
    if (subscribers.size !== 0) return;
    const ticket = ++teardownTicket;
    queueMicrotask(() => {
      if (ticket !== teardownTicket || subscribers.size !== 0) return;
      generation += 1;
      stopListener?.();
      stopListener = null;
    });
  };
}

/**
 * Reset transient listener ownership during app/community teardown. The manager
 * retains no snapshot, selection, identity, or other community-scoped data.
 */
export function resetOpsWatchManager(): void {
  teardownTicket += 1;
  generation += 1;
  subscribers.clear();
  stopListener?.();
  stopListener = null;
  setupPromise = null;
  nativeWatchStarted = false;
}
