import assert from "node:assert/strict";
import test from "node:test";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";

import {
  buildSettings,
  consumeSessionBootstrap,
  decodeSecretKey,
  hexToBytes,
  loadRelayUrl,
  normalizeRelayUrl,
  purgeLegacySecretSettings,
  saveRelayUrl,
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
    key: (index) => [...map.keys()][index] ?? null,
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

test("저장소에는 릴레이 URL 만 남긴다", () => {
  const storage = makeFakeStorage();
  const built = buildSettings("wss://relay.test", SECRET_HEX);
  assert.equal(built.ok, true);
  assert.equal(saveRelayUrl(built.settings.relayUrl, storage), true);
  assert.equal(loadRelayUrl(storage), built.settings.relayUrl);
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem("a2d2-tv-relay-url-v2"), "wss://relay.test/");
  assert.equal(
    [
      ...Array.from({ length: storage.length }, (_, index) =>
        storage.key(index),
      ),
    ]
      .filter(Boolean)
      .some((key) => storage.getItem(key).includes(SECRET_HEX)),
    false,
  );
});

test("깨진 릴레이 URL 저장값은 null", () => {
  const storage = makeFakeStorage();
  storage.setItem("a2d2-tv-relay-url-v2", "https://not-a-relay.test");
  assert.equal(loadRelayUrl(storage), null);
});

test("이전 localStorage 개인키 레코드를 시작할 때 지운다", () => {
  const storage = makeFakeStorage();
  storage.setItem(
    "a2d2-tv-settings-v1",
    JSON.stringify({ relayUrl: "wss://relay.test", secretKeyHex: SECRET_HEX }),
  );
  assert.equal(purgeLegacySecretSettings(storage), true);
  assert.equal(storage.getItem("a2d2-tv-settings-v1"), null);
});

test("세션 부트스트랩은 메모리에서 한 번만 읽고 즉시 지운다", () => {
  const scope = {
    __BUZZ_TV_SESSION__: {
      relayUrl: "wss://relay.test",
      secretKeyHex: SECRET_HEX,
    },
  };
  const settings = consumeSessionBootstrap(scope);
  assert.ok(settings);
  assert.equal(settings.relayUrl, "wss://relay.test/");
  assert.equal(settings.secretKeyHex, SECRET_HEX);
  assert.equal("__BUZZ_TV_SESSION__" in scope, false);
  assert.equal(consumeSessionBootstrap(scope), null);
});
