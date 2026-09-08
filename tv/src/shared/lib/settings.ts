// TV 설정: 릴레이 URL + 세션 전용 관전 키.
//
// 개인키는 React 상태와 RelayConnection 메모리에만 둔다. URL, localStorage,
// sessionStorage 에는 넣지 않는다. 릴레이 URL 만 다음 실행 편의를 위해 저장한다.

import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

export type TvSettings = {
  relayUrl: string;
  /** 관전용 개인키(64자리 hex). 앱 프로세스가 살아 있는 동안만 보관한다. */
  secretKeyHex: string;
  /** secretKeyHex 에서 유도한 공개키(hex). */
  pubkeyHex: string;
};

const RELAY_STORAGE_KEY = "a2d2-tv-relay-url-v2";
const LEGACY_SECRET_STORAGE_KEY = "a2d2-tv-settings-v1";
const SESSION_BOOTSTRAP_KEY = "__BUZZ_TV_SESSION__";

const HEX64 = /^[0-9a-f]{64}$/;

/** nsec1… 또는 64자리 hex 를 개인키 hex 로 푼다. 못 풀면 null. */
export function decodeSecretKey(input: string): string | null {
  const trimmed = input.trim();
  if (HEX64.test(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  if (trimmed.toLowerCase().startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== "nsec") return null;
      return bytesToHex(decoded.data);
    } catch {
      return null;
    }
  }
  return null;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function normalizeRelayUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // 스킴이 아예 없을 때만 wss:// 를 채운다 — https:// 같은 다른 스킴에
  // 덧씌우면 엉뚱한 주소가 되고, 아래 protocol 검사가 그걸 거른다.
  const withScheme = trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** 입력 두 값으로 설정을 만든다. 잘못된 입력이면 어디가 틀렸는지 돌려준다. */
export function buildSettings(
  relayInput: string,
  keyInput: string,
): { ok: true; settings: TvSettings } | { ok: false; error: string } {
  const relayUrl = normalizeRelayUrl(relayInput);
  if (!relayUrl) {
    return { ok: false, error: "릴레이 주소가 올바르지 않습니다 (wss://…)" };
  }
  const secretKeyHex = decodeSecretKey(keyInput);
  if (!secretKeyHex) {
    return {
      ok: false,
      error: "키가 올바르지 않습니다 (nsec1… 또는 64자리 hex)",
    };
  }
  let pubkeyHex: string;
  try {
    pubkeyHex = getPublicKey(hexToBytes(secretKeyHex));
  } catch {
    return { ok: false, error: "키에서 공개키를 만들지 못했습니다" };
  }
  return { ok: true, settings: { relayUrl, secretKeyHex, pubkeyHex } };
}

// localStorage 접근은 전부 try/catch 한다. 저장소가 막혀도 현재 세션은
// 설정 화면에서 입력한 값으로 계속 동작한다.

export function loadRelayUrl(storage?: Storage): string | null {
  const store = storage ?? safeLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(RELAY_STORAGE_KEY);
    return raw ? normalizeRelayUrl(raw) : null;
  } catch {
    return null;
  }
}

export function saveRelayUrl(relayUrl: string, storage?: Storage): boolean {
  const store = storage ?? safeLocalStorage();
  if (!store) return false;
  try {
    store.setItem(RELAY_STORAGE_KEY, relayUrl);
    return true;
  } catch {
    return false;
  }
}

/** 이전 버전이 localStorage 에 남긴 개인키 레코드를 무조건 지운다. */
export function purgeLegacySecretSettings(storage?: Storage): boolean {
  const store = storage ?? safeLocalStorage();
  if (!store) return false;
  try {
    store.removeItem(LEGACY_SECRET_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

type SessionBootstrapScope = Record<string, unknown>;

/**
 * 검증 러너 같은 신뢰된 호스트가 문서 평가 전에 메모리에 넣은 설정을 한 번만
 * 읽고 즉시 전역에서 지운다. 이 통로는 URL이나 웹 저장소를 사용하지 않는다.
 */
export function consumeSessionBootstrap(
  scope: SessionBootstrapScope = globalThis as SessionBootstrapScope,
): TvSettings | null {
  const raw = scope[SESSION_BOOTSTRAP_KEY];
  try {
    delete scope[SESSION_BOOTSTRAP_KEY];
  } catch {
    scope[SESSION_BOOTSTRAP_KEY] = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.relayUrl !== "string" ||
    typeof candidate.secretKeyHex !== "string"
  ) {
    return null;
  }
  const result = buildSettings(candidate.relayUrl, candidate.secretKeyHex);
  return result.ok ? result.settings : null;
}
