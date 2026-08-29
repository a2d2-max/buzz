import { useSyncExternalStore } from "react";

import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";

export const LOCAL_OPS_GUEST_STORAGE_KEY = "buzz-local-ops-guest.v1";

type Listener = () => void;
const listeners = new Set<Listener>();
let sessionEnabled = false;

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function handleStorageChange(event: StorageEvent) {
  if (event.key !== LOCAL_OPS_GUEST_STORAGE_KEY) return;
  sessionEnabled = event.newValue === "true";
  emitChange();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleStorageChange);
}

export function isLocalOpsGuestModeEnabled(): boolean {
  return (
    sessionEnabled || getStorageItem(LOCAL_OPS_GUEST_STORAGE_KEY) === "true"
  );
}

export function enableLocalOpsGuestMode(): void {
  sessionEnabled = true;
  setStorageItem(LOCAL_OPS_GUEST_STORAGE_KEY, "true");
  emitChange();
}

export function clearLocalOpsGuestMode(): void {
  sessionEnabled = false;
  removeStorageItem(LOCAL_OPS_GUEST_STORAGE_KEY);
  emitChange();
}

export function useLocalOpsGuestMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    isLocalOpsGuestModeEnabled,
    () => false,
  );
}
