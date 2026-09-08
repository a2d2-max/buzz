// TV 설정: 릴레이 URL + 관전용 키.
//
// - 리모컨으로 nsec 를 치는 건 고문이라 URL 해시/쿼리(#relay=…&key=…)로도
//   주입받는다. 주입받으면 즉시 저장하고 주소창에서 지운다(키가 화면·히스토리에
//   남지 않게).
// - localStorage 는 TV 에서 예고 없이 지워질 수 있으니(공장초기화·용량 축출)
//   "언제든 사라지는 캐시"로 취급한다 — 없으면 설정 화면으로 돌아간다.

import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

export type TvSettings = {
  relayUrl: string;
  /** 관전용 개인키(64자리 hex). nsec 는 저장 전에 hex 로 푼다. */
  secretKeyHex: string;
  /** secretKeyHex 에서 유도한 공개키(hex). */
  pubkeyHex: string;
};

const STORAGE_KEY = "a2d2-tv-settings-v1";

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

// localStorage 접근은 전부 try/catch — TV/시뮬레이터에 따라 접근 자체가
// 막혀 있을 수 있고, 그 경우에도 앱은 설정 화면으로 살아 있어야 한다.

export function loadSettings(storage?: Storage): TvSettings | null {
  const store = storage ?? safeLocalStorage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TvSettings>;
    if (
      typeof parsed.relayUrl !== "string" ||
      typeof parsed.secretKeyHex !== "string" ||
      !HEX64.test(parsed.secretKeyHex)
    ) {
      return null;
    }
    // 공개키는 저장값을 믿지 않고 매번 다시 유도한다(저장소가 반쯤 깨졌을 때 대비).
    const pubkeyHex = getPublicKey(hexToBytes(parsed.secretKeyHex));
    return {
      relayUrl: parsed.relayUrl,
      secretKeyHex: parsed.secretKeyHex,
      pubkeyHex,
    };
  } catch {
    return null;
  }
}

export function saveSettings(settings: TvSettings, storage?: Storage): boolean {
  const store = storage ?? safeLocalStorage();
  if (!store) return false;
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        relayUrl: settings.relayUrl,
        secretKeyHex: settings.secretKeyHex,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSettings(storage?: Storage): void {
  const store = storage ?? safeLocalStorage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // 지우기 실패는 무시 — 다음 load 검증에서 걸러진다.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * URL 로 주입된 설정(#relay=…&key=… 또는 ?relay=…&key=…)을 읽는다.
 * 해시가 쿼리보다 우선한다(해시는 서버 로그에 안 남아 키 전달에 더 낫다).
 */
export function readLaunchParams(location: { search: string; hash: string }): {
  relay?: string;
  key?: string;
} {
  const merged: { relay?: string; key?: string } = {};
  for (const raw of [location.search, location.hash]) {
    const query =
      raw.startsWith("#") || raw.startsWith("?") ? raw.slice(1) : raw;
    if (!query) continue;
    const params = new URLSearchParams(query);
    const relay = params.get("relay");
    const key = params.get("key");
    if (relay) merged.relay = relay;
    if (key) merged.key = key;
  }
  return merged;
}

/** 주소창에서 주입 파라미터를 지운다(키가 화면·북마크에 남지 않게). */
export function stripLaunchParams(): void {
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    window.history.replaceState(null, "", url.toString());
  } catch {
    // 못 지워도 동작엔 지장 없다.
  }
}
