import assert from "node:assert/strict";
import test from "node:test";

import { isBackKey, KEY_BACK_WEBOS } from "./keys.ts";

test("webOS 뒤로가기 키코드 461 을 잡는다", () => {
  assert.equal(KEY_BACK_WEBOS, 461);
  assert.equal(isBackKey({ keyCode: 461, key: "GoBack" }), true);
  assert.equal(isBackKey({ keyCode: 461, key: "" }), true);
});

test("개발용 Escape 도 뒤로가기로 본다", () => {
  assert.equal(isBackKey({ keyCode: 27, key: "Escape" }), true);
  assert.equal(isBackKey({ keyCode: 0, key: "Escape" }), true);
});

test("다른 키는 아니다", () => {
  assert.equal(isBackKey({ keyCode: 13, key: "Enter" }), false);
  assert.equal(isBackKey({ keyCode: 40, key: "ArrowDown" }), false);
});
