import assert from "node:assert/strict";
import test from "node:test";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

import {
  buildSettings,
  clearSettings,
  decodeSecretKey,
  hexToBytes,
  loadSettings,
  normalizeRelayUrl,
  readLaunchParams,
  saveSettings,
} from "./settings.ts";

// 시험용으로만 쓰는 고정 키(실제 어디에도 등록돼 있지 않은 값).
const SECRET_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

function makeFakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

test("decodeSecretKey: 64자리 hex 를 그대로 받는다", () => {
  assert.equal(decodeSecretKey(SECRET_HEX), SECRET_HEX);
  assert.equal(decodeSecretKey(SECRET_HEX.toUpperCase()), SECRET_HEX);
});

test("decodeSecretKey: nsec 를 hex 로 푼다", () => {
  const nsec = nip19.nsecEncode(hexToBytes(SECRET_HEX));
  assert.equal(decodeSecretKey(nsec), SECRET_HEX);
});

test("decodeSecretKey: 잘못된 입력은 null", () => {
  assert.equal(decodeSecretKey(""), null);
  assert.equal(decodeSecretKey("nsec1nonsense"), null);
  assert.equal(decodeSecretKey("deadbeef"), null);
  // npub(공개키)는 개인키가 아니다
  const npub = nip19.npubEncode(getPublicKey(hexToBytes(SECRET_HEX)));
  assert.equal(decodeSecretKey(npub), null);
});

test("normalizeRelayUrl: 스킴을 채우고 ws/wss 만 받는다", () => {
  assert.equal(
    normalizeRelayUrl("a2d2.example.com"),
    "wss://a2d2.example.com/",
  );
  assert.equal(
    normalizeRelayUrl("ws://localhost:3000"),
    "ws://localhost:3000/",
  );
  assert.equal(normalizeRelayUrl("https://example.com"), null);
  assert.equal(normalizeRelayUrl(""), null);
});

test("buildSettings: 공개키를 유도해 담는다", () => {
  const result = buildSettings("wss://relay.test", SECRET_HEX);
  assert.equal(result.ok, true);
  assert.equal(result.settings.pubkeyHex, getPublicKey(hexToBytes(SECRET_HEX)));
});

test("저장 → 불러오기 → 지우기 왕복", () => {
  const storage = makeFakeStorage();
  const built = buildSettings("wss://relay.test", SECRET_HEX);
  assert.equal(built.ok, true);
  assert.equal(saveSettings(built.settings, storage), true);

  const loaded = loadSettings(storage);
  assert.ok(loaded);
  assert.equal(loaded.relayUrl, built.settings.relayUrl);
  assert.equal(loaded.secretKeyHex, SECRET_HEX);
  assert.equal(loaded.pubkeyHex, built.settings.pubkeyHex);

  clearSettings(storage);
  assert.equal(loadSettings(storage), null);
});

test("깨진 저장값은 null (캐시 취급 — 설정 화면으로 돌아가는 근거)", () => {
  const storage = makeFakeStorage();
  storage.setItem("a2d2-tv-settings-v1", "{not json");
  assert.equal(loadSettings(storage), null);
  storage.setItem("a2d2-tv-settings-v1", JSON.stringify({ relayUrl: "x" }));
  assert.equal(loadSettings(storage), null);
});

test("readLaunchParams: 해시가 쿼리보다 우선한다", () => {
  const params = readLaunchParams({
    search: "?relay=wss%3A%2F%2Fquery.example&key=aaa",
    hash: "#relay=wss%3A%2F%2Fhash.example&key=bbb",
  });
  assert.equal(params.relay, "wss://hash.example");
  assert.equal(params.key, "bbb");
});

test("readLaunchParams: 한쪽만 있어도 읽는다", () => {
  const params = readLaunchParams({ search: "", hash: "#relay=wss://x" });
  assert.equal(params.relay, "wss://x");
  assert.equal(params.key, undefined);
});
