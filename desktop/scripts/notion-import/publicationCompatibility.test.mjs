import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPublicationCompatibilityReport } from "./publicationCompatibility.ts";

function uploadAsset(hash, bytes, mime) {
  return {
    sourceSha256: hash,
    bytes,
    mime,
    sourceKinds: ["zip-binary"],
    entryCount: 1,
    referenceCount: 1,
    uploadStatus: "not-uploaded",
    remoteSha256: null,
    remoteUrl: null,
    readbackVerified: false,
  };
}

test("reports only active Node and Buzz CLI blockers without claiming runtime verification", () => {
  const hashes = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
  const extensions = [".m4a", ".mov", ".mp4", ".svg", ".png"];
  const sizes = [1, 60 * 1024 * 1024, 60 * 1024 * 1024, 4, 5];
  const report = buildPublicationCompatibilityReport({
    publicManifest: {
      uploadAssets: hashes.map((hash, index) =>
        uploadAsset(hash, sizes[index], "application/octet-stream"),
      ),
    },
    privateManifest: {
      binaryEntries: hashes.map((hash, index) => ({
        archivePath: `source${extensions[index]}`,
        sha256: hash,
      })),
      references: [],
    },
  });

  assert.equal(report.evidenceScope, "node-buzz-cli-source-audit-only");
  assert.equal(report.deployedUploadLimitsRuntimeVerified, false);
  assert.equal(report.buzzCliExecutionAdapterImplemented, true);
  assert.equal("buzzCliRuntimeIntegrationVerified" in report, false);
  assert.equal(report.operationalUploadReady, false);
  assert.deepEqual(report.summary, {
    assetCount: 5,
    sourceBytes: sizes.reduce((sum, value) => sum + value, 0),
    maxSourceBytes: 60 * 1024 * 1024,
    formatBlockedCount: 3,
    buzzCliReadbackBlockedCount: 0,
    mp4RuntimeValidationRequiredCount: 1,
    svgBlockedCount: 1,
  });
  assert.ok(
    report.assets[0].reasons.includes("m4a-audio-iso-bmff-unsupported"),
  );
  assert.ok(report.assets[1].reasons.includes("mov-container-unsupported"));
  assert.equal(
    report.assets.some((asset) =>
      asset.reasons.some((reason) =>
        /^(?:desktop-|native-|node-tauri-)/.test(reason),
      ),
    ),
    false,
  );
  assert.ok(
    report.assets[2].reasons.includes(
      "video-format-runtime-validation-required",
    ),
  );
  assert.ok(report.assets[3].reasons.includes("svg-active-content-rejected"));
  assert.equal(report.assets[1].buzzCliUploadCompatibility, "blocked");
  assert.equal(
    report.assets[2].buzzCliReadbackCompatibility,
    "wired-unverified",
  );
  assert.equal(report.liveUploadCount, 0);
  assert.equal(report.liveReadbackCount, 0);
});
