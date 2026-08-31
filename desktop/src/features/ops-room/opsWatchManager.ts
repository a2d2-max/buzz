import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { startOpsWatch, stopOpsWatch } from "./opsBridge";

export interface OpsInvalidationPayload {
  connection_generation?: number;
  sync_required?: boolean;
  anchor_sequence?: string;
  reason?: string;
  full_reload?: boolean;
  setup_refresh?: boolean;
  sync_ticket?: number;
}

type Subscriber = (payload: OpsInvalidationPayload) => void;

const OPS_INVALIDATED_EVENT = "buzz://ops-invalidated";
const subscribers = new Set<Subscriber>();
let setupPromise: Promise<void> | null = null;
let stopListener: (() => void) | null = null;
let generation = 0;
let teardownTicket = 0;
let pendingSyncGeneration: number | null = null;
let pendingSyncTicket = 0;
let resetPromise: Promise<void> | null = null;

function broadcast(payload: OpsInvalidationPayload): void {
  let delivered = payload;
  if (
    payload.sync_required === true &&
    Number.isSafeInteger(payload.connection_generation)
  ) {
    pendingSyncGeneration = payload.connection_generation ?? null;
    pendingSyncTicket += 1;
    delivered = { ...payload, sync_ticket: pendingSyncTicket };
  }
  for (const subscriber of subscribers) subscriber(delivered);
}

export function completeOpsSync(generation: number, ticket: number): void {
  if (pendingSyncGeneration === generation && pendingSyncTicket === ticket) {
    pendingSyncGeneration = null;
  }
}

export function isOpsSyncCurrent(generation: number, ticket: number): boolean {
  return pendingSyncGeneration === generation && pendingSyncTicket === ticket;
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
    const status = await startOpsWatch();
    if (
      status.sync_required === true &&
      status.connection_generation !== undefined &&
      pendingSyncGeneration !== status.connection_generation
    ) {
      broadcast({
        connection_generation: status.connection_generation,
        sync_required: true,
        anchor_sequence: status.anchor_sequence ?? undefined,
        reason: "resume",
        full_reload: true,
      });
    } else if (status.sync_required !== true) {
      broadcast({ setup_refresh: true });
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
}

export async function ensureOpsWatchManager(): Promise<void> {
  if (resetPromise) await resetPromise;
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
export async function resetOpsWatchManager(): Promise<void> {
  const activeReset = resetPromise;
  teardownTicket += 1;
  generation += 1;
  subscribers.clear();
  stopListener?.();
  stopListener = null;
  const setupToSettle = setupPromise;
  setupPromise = null;
  pendingSyncGeneration = null;
  pendingSyncTicket += 1;
  if (activeReset) {
    await activeReset;
    return;
  }
  const pending = (async () => {
    if (setupToSettle) {
      try {
        await setupToSettle;
      } catch {
        // Reset owns the terminal stop below, so a superseded setup failure
        // must not bypass native generation invalidation.
      }
    }
    if (isTauri()) await stopOpsWatch();
  })();
  resetPromise = pending;
  try {
    await pending;
  } finally {
    if (resetPromise === pending) resetPromise = null;
  }
}
