import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { RAOU_PRODUCT } from "./productBrand.ts";

test("Tauri release and dev product names match the visible brand source", async () => {
  const [release, dev] = await Promise.all([
    readFile(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src-tauri/tauri.dev.conf.json", import.meta.url),
      "utf8",
    ),
  ]);

  assert.equal(JSON.parse(release).productName, RAOU_PRODUCT.name);
  assert.equal(JSON.parse(dev).productName, `${RAOU_PRODUCT.name} Dev`);
});

test("native bundle metadata and artwork use the RAOU brand", async () => {
  const [releaseSource, infoPlist, instanceEnv, iconSource] = await Promise.all(
    [
      readFile(
        new URL("../../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../src-tauri/Info.plist", import.meta.url), "utf8"),
      readFile(
        new URL("../../../scripts/instance-env.sh", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../src-tauri/icons/raou-source.svg", import.meta.url),
        "utf8",
      ),
    ],
  );
  const release = JSON.parse(releaseSource);
  const requiredArtwork = [
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.icns",
    "icon.ico",
    "dmg-background.png",
  ];

  assert.ok(
    release.bundle.icon.every((path) => path.startsWith("icons/raou/")),
  );
  assert.equal(
    release.bundle.macOS.dmg.background,
    "icons/raou/dmg-background.png",
  );
  assert.match(infoPlist, /<string>RAOU<\/string>/);
  assert.doesNotMatch(infoPlist, /Buzz/);
  assert.match(instanceEnv, /BASE_ICON=.*icons\/raou\/icon\.icns/);
  assert.match(
    instanceEnv,
    /\\"productName\\":\\"RAOU Dev \(\$\{BUZZ_WORKTREE_LABEL\}\)\\"/,
  );
  assert.match(iconSource, /#101315/i);
  assert.match(iconSource, /#C8FF45/i);
  assert.doesNotMatch(iconSource, /buzz|bee|honeycomb/i);

  await Promise.all(
    requiredArtwork.map((name) =>
      access(new URL(`../../src-tauri/icons/raou/${name}`, import.meta.url)),
    ),
  );
});

test("the document advertises a RAOU favicon without reusing Buzz artwork", async () => {
  const [index, favicon] = await Promise.all([
    readFile(new URL("../../index.html", import.meta.url), "utf8"),
    readFile(new URL("../../public/raou.svg", import.meta.url), "utf8"),
  ]);

  assert.match(index, /rel="icon"[^>]+href="\/raou\.svg\?v=\d+"/);
  assert.doesNotMatch(index, /href="\/buzz\.svg/);
  assert.match(favicon, /#101315/i);
  assert.match(favicon, /#C8FF45/i);
  assert.doesNotMatch(favicon, /buzz|bee|honeycomb/i);
});
