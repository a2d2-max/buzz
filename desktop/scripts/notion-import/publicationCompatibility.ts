import path from "node:path";

import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
} from "./publicationAssets.ts";

export type PublicationCompatibilityReason =
  | "buzz-cli-readback-over-500-mib"
  | "m4a-audio-iso-bmff-unsupported"
  | "mov-container-unsupported"
  | "production-upload-not-runtime-verified"
  | "svg-active-content-rejected"
  | "video-format-runtime-validation-required";

export type PublicationAssetCompatibility = {
  sourceSha256: string;
  sourceBytes: number;
  sourceMime: string;
  sourceExtensions: string[];
  entryCount: number;
  referenceCount: number;
  buzzCliUploadCompatibility: "blocked" | "wired-unverified";
  buzzCliReadbackCompatibility: "blocked" | "wired-unverified";
  operationalUploadReady: false;
  reasons: PublicationCompatibilityReason[];
};

export type PublicationCompatibilityReport = {
  version: 1;
  mode: "source-code-compatibility-audit";
  evidenceScope: "node-buzz-cli-source-audit-only";
  deployedUploadLimitsRuntimeVerified: false;
  liveUploadCount: 0;
  liveReadbackCount: 0;
  liveSignedEventCount: 0;
  livePublishedEventCount: 0;
  buzzCliExecutionAdapterImplemented: true;
  operationalUploadReady: false;
  summary: {
    assetCount: number;
    sourceBytes: number;
    maxSourceBytes: number;
    formatBlockedCount: number;
    buzzCliReadbackBlockedCount: number;
    mp4RuntimeValidationRequiredCount: number;
    svgBlockedCount: number;
  };
  sourceCodeEvidence: Array<{
    path: string;
    symbol: string;
    fact: string;
  }>;
  assets: PublicationAssetCompatibility[];
};

const BUZZ_CLI_READBACK_MAX_BYTES = 500 * 1024 * 1024;

function extensionsByHash(
  privateManifest: PrivatePublicationAssetManifest,
): Map<string, Set<string>> {
  const byHash = new Map<string, Set<string>>();
  for (const entry of privateManifest.binaryEntries) {
    const extension = path.posix.extname(entry.archivePath).toLowerCase();
    const current = byHash.get(entry.sha256) ?? new Set<string>();
    current.add(extension || "<none>");
    byHash.set(entry.sha256, current);
  }
  for (const reference of privateManifest.references) {
    if (reference.sourceKind !== "inline") continue;
    const current = byHash.get(reference.sourceSha256) ?? new Set<string>();
    current.add("<inline-data-url>");
    byHash.set(reference.sourceSha256, current);
  }
  return byHash;
}

/** Describe what the existing Desktop upload/readback seams can prove locally. */
export function buildPublicationCompatibilityReport({
  publicManifest,
  privateManifest,
}: {
  publicManifest: PublicPublicationAssetManifest;
  privateManifest: PrivatePublicationAssetManifest;
}): PublicationCompatibilityReport {
  const sourceExtensions = extensionsByHash(privateManifest);
  const assets = publicManifest.uploadAssets.map((asset) => {
    const extensions = [
      ...(sourceExtensions.get(asset.sourceSha256) ?? []),
    ].sort();
    const reasons = new Set<PublicationCompatibilityReason>([
      "production-upload-not-runtime-verified",
    ]);
    if (extensions.includes(".m4a")) {
      reasons.add("m4a-audio-iso-bmff-unsupported");
    }
    if (extensions.includes(".mov")) reasons.add("mov-container-unsupported");
    if (extensions.includes(".mp4")) {
      reasons.add("video-format-runtime-validation-required");
    }
    if (extensions.includes(".svg")) {
      reasons.add("svg-active-content-rejected");
    }
    if (asset.bytes > BUZZ_CLI_READBACK_MAX_BYTES) {
      reasons.add("buzz-cli-readback-over-500-mib");
    }
    const buzzCliUploadBlocked =
      reasons.has("m4a-audio-iso-bmff-unsupported") ||
      reasons.has("mov-container-unsupported") ||
      reasons.has("svg-active-content-rejected");
    return {
      sourceSha256: asset.sourceSha256,
      sourceBytes: asset.bytes,
      sourceMime: asset.mime,
      sourceExtensions: extensions,
      entryCount: asset.entryCount,
      referenceCount: asset.referenceCount,
      buzzCliUploadCompatibility: buzzCliUploadBlocked
        ? "blocked"
        : "wired-unverified",
      buzzCliReadbackCompatibility: reasons.has(
        "buzz-cli-readback-over-500-mib",
      )
        ? "blocked"
        : "wired-unverified",
      operationalUploadReady: false,
      reasons: [...reasons].sort(),
    } satisfies PublicationAssetCompatibility;
  });
  const hasReason = (
    asset: PublicationAssetCompatibility,
    reason: PublicationCompatibilityReason,
  ) => asset.reasons.includes(reason);
  const formatBlocked = new Set(
    assets
      .filter(
        (asset) =>
          hasReason(asset, "m4a-audio-iso-bmff-unsupported") ||
          hasReason(asset, "mov-container-unsupported") ||
          hasReason(asset, "svg-active-content-rejected"),
      )
      .map((asset) => asset.sourceSha256),
  );
  const buzzCliReadbackBlocked = new Set(
    assets
      .filter((asset) => hasReason(asset, "buzz-cli-readback-over-500-mib"))
      .map((asset) => asset.sourceSha256),
  );
  return {
    version: 1,
    mode: "source-code-compatibility-audit",
    evidenceScope: "node-buzz-cli-source-audit-only",
    deployedUploadLimitsRuntimeVerified: false,
    liveUploadCount: 0,
    liveReadbackCount: 0,
    liveSignedEventCount: 0,
    livePublishedEventCount: 0,
    buzzCliExecutionAdapterImplemented: true,
    operationalUploadReady: false,
    summary: {
      assetCount: assets.length,
      sourceBytes: assets.reduce((sum, asset) => sum + asset.sourceBytes, 0),
      maxSourceBytes: assets.reduce(
        (maximum, asset) => Math.max(maximum, asset.sourceBytes),
        0,
      ),
      formatBlockedCount: formatBlocked.size,
      buzzCliReadbackBlockedCount: buzzCliReadbackBlocked.size,
      mp4RuntimeValidationRequiredCount: assets.filter((asset) =>
        hasReason(asset, "video-format-runtime-validation-required"),
      ).length,
      svgBlockedCount: assets.filter((asset) =>
        hasReason(asset, "svg-active-content-rejected"),
      ).length,
    },
    sourceCodeEvidence: [
      {
        path: "crates/buzz-media/src/validation.rs",
        symbol: "validate_video_file",
        fact: "rejects QuickTime containers and audio-only ISO-BMFF",
      },
      {
        path: "crates/buzz-relay/src/config.rs",
        symbol: "BUZZ_MAX_VIDEO_BYTES/BUZZ_MAX_FILE_BYTES",
        fact: "code defaults are 500 MiB video and 100 MiB generic, not deployed proof",
      },
      {
        path: "crates/buzz-cli/src/client.rs",
        symbol: "upload_file/download_media",
        fact: "provides bounded authenticated Blossom upload and media readback for the Node adapter",
      },
      {
        path: "desktop/scripts/notion-import/buzzCliPublicationAdapter.ts",
        symbol: "createBuzzCliPublicationApi",
        fact: "runs in Node and delegates identity, upload, readback, query, signing, and publish to the existing authenticated Buzz CLI transport",
      },
    ],
    assets,
  };
}
