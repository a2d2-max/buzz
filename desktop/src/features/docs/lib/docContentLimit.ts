import { relayHttpFromWs } from "@/shared/api/inviteHelpers";
import { getRelayWsUrl } from "@/shared/api/tauri";

import { DEDICATED_KIND_RECHECK_MS } from "./docKindSupport";

/** Safe fallback for relays that do not advertise a usable NIP-11 limit. */
export const DOC_DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;

/** Keep relay capability snapshots for the same interval as doc-kind support. */
export const DOC_CONTENT_LIMIT_RECHECK_MS = DEDICATED_KIND_RECHECK_MS;

/** Total time allowed for connection, headers, and the complete NIP-11 body. */
export const DOC_RELAY_INFO_TIMEOUT_MS = 5_000;

/** Maximum NIP-11 response body read by the Docs save path. */
export const DOC_RELAY_INFO_MAX_BYTES = 64 * 1024;

const STORAGE_KEY_PREFIX = "docs:max-content-bytes:";

type RelayInfoFetcher = (
  relayUrl: string,
  signal?: AbortSignal,
) => Promise<unknown>;

function advertisedMaxContentBytes(relayInfo: unknown): number | null {
  if (!relayInfo || typeof relayInfo !== "object" || Array.isArray(relayInfo)) {
    return null;
  }
  const limitation = (relayInfo as Record<string, unknown>).limitation;
  if (
    !limitation ||
    typeof limitation !== "object" ||
    Array.isArray(limitation)
  ) {
    return null;
  }
  const value = (limitation as Record<string, unknown>).max_content_length;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** Resolve the relay's UTF-8 event-content byte ceiling with a safe fallback. */
export function resolveMaxContentBytes(relayInfo: unknown): number {
  return advertisedMaxContentBytes(relayInfo) ?? DOC_DEFAULT_MAX_CONTENT_BYTES;
}

function storageKey(relayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${relayUrl}`;
}

function readCachedLimit(relayUrl: string, nowMs: number): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(relayUrl));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const checkedAt = record.checkedAt;
    const maxContentBytes = record.maxContentBytes;
    if (
      typeof checkedAt !== "number" ||
      !Number.isFinite(checkedAt) ||
      typeof maxContentBytes !== "number" ||
      !Number.isSafeInteger(maxContentBytes) ||
      maxContentBytes <= 0 ||
      nowMs - checkedAt >= DOC_CONTENT_LIMIT_RECHECK_MS
    ) {
      return null;
    }
    return maxContentBytes;
  } catch {
    return null;
  }
}

function rememberLimit(
  relayUrl: string,
  maxContentBytes: number,
  checkedAt: number,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(relayUrl),
      JSON.stringify({ checkedAt, maxContentBytes }),
    );
  } catch {
    // Storage is an optimization. A later save can fetch NIP-11 again.
  }
}

async function fetchRelayInformationDocument(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(relayHttpFromWs(relayUrl), {
    headers: { Accept: "application/nostr+json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Relay information request failed (${response.status}).`);
  }

  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (
      Number.isSafeInteger(declaredBytes) &&
      declaredBytes > DOC_RELAY_INFO_MAX_BYTES
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Relay information response is too large.");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Relay information response has no body.");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > DOC_RELAY_INFO_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error("Relay information response is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

async function fetchRelayInfoWithinDeadline(
  relayUrl: string,
  fetchInfo: RelayInfoFetcher,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Relay information request timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchInfo(relayUrl, controller.signal)),
      timedOut,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

/** Fetch and remember one relay's advertised content limit. */
export async function resolveRelayMaxContentBytes(
  relayUrl: string,
  nowMs: number = Date.now(),
  fetchInfo: RelayInfoFetcher = fetchRelayInformationDocument,
  timeoutMs: number = DOC_RELAY_INFO_TIMEOUT_MS,
): Promise<number> {
  const cached = readCachedLimit(relayUrl, nowMs);
  if (cached !== null) return cached;

  try {
    const relayInfo = await fetchRelayInfoWithinDeadline(
      relayUrl,
      fetchInfo,
      timeoutMs,
    );
    const advertised = advertisedMaxContentBytes(relayInfo);
    if (advertised === null) return DOC_DEFAULT_MAX_CONTENT_BYTES;
    rememberLimit(relayUrl, advertised, nowMs);
    return advertised;
  } catch {
    return DOC_DEFAULT_MAX_CONTENT_BYTES;
  }
}

export interface CurrentRelayContentLimit {
  relayUrl: string;
  maxContentBytes: number;
}

/**
 * Resolve the active relay and its limit as one fenced capability snapshot.
 * A community switch while NIP-11 is in flight aborts the caller.
 */
export async function resolveCurrentRelayContentLimit(
  getCurrentRelayUrl: () => Promise<string> = getRelayWsUrl,
  nowMs: number = Date.now(),
  fetchInfo: RelayInfoFetcher = fetchRelayInformationDocument,
): Promise<CurrentRelayContentLimit> {
  let relayUrl: string;
  try {
    relayUrl = await getCurrentRelayUrl();
  } catch {
    throw new Error("Could not confirm the active community before saving.");
  }
  const maxContentBytes = await resolveRelayMaxContentBytes(
    relayUrl,
    nowMs,
    fetchInfo,
  );
  let currentRelayUrl: string;
  try {
    currentRelayUrl = await getCurrentRelayUrl();
  } catch {
    throw new Error("Could not confirm the active community before saving.");
  }
  if (currentRelayUrl !== relayUrl) {
    throw new Error("The active community changed before the page was saved.");
  }
  return { relayUrl, maxContentBytes };
}

/** Resolve only the active relay's content ceiling. */
export async function resolveCurrentRelayMaxContentBytes(
  getCurrentRelayUrl: () => Promise<string> = getRelayWsUrl,
  nowMs: number = Date.now(),
  fetchInfo: RelayInfoFetcher = fetchRelayInformationDocument,
): Promise<number> {
  const { maxContentBytes } = await resolveCurrentRelayContentLimit(
    getCurrentRelayUrl,
    nowMs,
    fetchInfo,
  );
  return maxContentBytes;
}
