import assert from "node:assert/strict";
import test from "node:test";

import { isRedirect } from "@tanstack/react-router";

import { Route } from "./apps.$product.tsx";

function runBeforeLoad(product) {
  const beforeLoad = Route.options.beforeLoad;
  assert.equal(typeof beforeLoad, "function");
  return beforeLoad({ params: { product } });
}

function captureRedirect(product) {
  try {
    runBeforeLoad(product);
    assert.fail("legacy app route must redirect");
  } catch (error) {
    assert.equal(isRedirect(error), true);
    return error.options;
  }
}

test("configured AFFiNE and Plane routes retain their full-app host", () => {
  assert.equal(runBeforeLoad("affine"), undefined);
  assert.equal(runBeforeLoad("plane"), undefined);
  assert.equal(typeof Route.options.component, "function");
});

test("unknown legacy app routes return to the safe app root", () => {
  assert.deepEqual(captureRedirect("unknown"), {
    to: "/",
    replace: true,
    statusCode: 307,
  });
});
