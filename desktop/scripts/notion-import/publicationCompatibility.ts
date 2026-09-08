import os from "node:os";
import path from "node:path";

import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
} from "./publicationAssets.ts";

export type PublicationCompatibilityReason =
  | "buzz-cli-readback-over-500-mib"
  | "desktop-upload-source-outside-temp"
  | "m4a-audio-iso-bmff-unsupported"
  | "mov-container-unsupported"
  | "native-readback-over-50-mib"
  | "node-tauri-execution-host-bridge-missing"
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
  uploadCompatibility: "blocked" | "unverified";
  readbackCompatibility: "blocked" | "unverified";
  buzzCliUploadCompatibility: "blocked" | "wired-unverified";
  buzzCliReadbackCompatibility: "blocked" | "wired-unverified";
  operationalUploadReady: false;
  reasons: PublicationCompatibilityReason[];
};

export type PublicationCompatibilityReport = {
  version: 1;
  mode: "source-code-compatibility-audit";
  evidenceScope: "code-inferred-and-local-host-smoke-only";
  deployedUploadLimitsRuntimeVerified: false;
  liveUploadCount: 0;
  liveReadbackCount: 0;
  liveSignedEventCount: 0;
  livePublishedEventCount: 0;
  standaloneNodeAdapterLoaded: true;
  tauriRuntimeAvailableInStandaloneNode: false;
  nodeTauriExecutionHostBridgeAvailable: false;
  buzzCliExecutionAdapterImplemented: true;
  retainedOutputInsideOsTemp: boolean;
  operationalUploadReady: false;
  summary: {
    assetCount: number;
    sourceBytes: number;
    maxSourceBytes: number;
    sourceOutsideTempCount: number;
    nodeTauriHostBlockedCount: number;
    formatBlockedCount: number;
    nativeReadbackBlockedCount: number;
    formatOrReadbackBlockedCount: number;
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

const NATIVE_READBACK_MAX_BYTES = 50 * 1024 * 1024;
const BUZZ_CLI_READBACK_MAX_BYTES = 500 * 1024 * 1024;

function retainedOutputInsideOsTemp(outputDirectory: string): boolean {
  const output = path.resolve(outputDirectory);
  const temp = path.resolve(os.tmpdir());
  return output === temp || output.startsWith(`${temp}${path.sep}`);
}

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
  outputDirectory,
}: {
  publicManifest: PublicPublicationAssetManifest;
  privateManifest: PrivatePublicationAssetManifest;
  outputDirectory: string;
}): PublicationCompatibilityReport {
  const insideTemp = retainedOutputInsideOsTemp(outputDirectory);
  const sourceExtensions = extensionsByHash(privateManifest);
  const assets = publicManifest.uploadAssets.map((asset) => {
    const extensions = [
      ...(sourceExtensions.get(asset.sourceSha256) ?? []),
    ].sort();
    const reasons = new Set<PublicationCompatibilityReason>([
      "node-tauri-execution-host-bridge-missing",
      "production-upload-not-runtime-verified",
    ]);
    if (!insideTemp) reasons.add("desktop-upload-source-outside-temp");
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
    if (asset.bytes > NATIVE_READBACK_MAX_BYTES) {
      reasons.add("native-readback-over-50-mib");
    }
    if (asset.bytes > BUZZ_CLI_READBACK_MAX_BYTES) {
      reasons.add("buzz-cli-readback-over-500-mib");
    }
    const hardUploadBlock =
      reasons.has("node-tauri-execution-host-bridge-missing") ||
      reasons.has("desktop-upload-source-outside-temp") ||
      reasons.has("m4a-audio-iso-bmff-unsupported") ||
      reasons.has("mov-container-unsupported") ||
      reasons.has("svg-active-content-rejected");
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
      uploadCompatibility: hardUploadBlock ? "blocked" : "unverified",
      readbackCompatibility: reasons.has("native-readback-over-50-mib")
        ? "blocked"
        : "unverified",
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
  const readbackBlocked = new Set(
    assets
      .filter((asset) => hasReason(asset, "native-readback-over-50-mib"))
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
    evidenceScope: "code-inferred-and-local-host-smoke-only",
    deployedUploadLimitsRuntimeVerified: false,
    liveUploadCount: 0,
    liveReadbackCount: 0,
    liveSignedEventCount: 0,
    livePublishedEventCount: 0,
    standaloneNodeAdapterLoaded: true,
    tauriRuntimeAvailableInStandaloneNode: false,
    nodeTauriExecutionHostBridgeAvailable: false,
    buzzCliExecutionAdapterImplemented: true,
    retainedOutputInsideOsTemp: insideTemp,
    operationalUploadReady: false,
    summary: {
      assetCount: assets.length,
      sourceBytes: assets.reduce((sum, asset) => sum + asset.sourceBytes, 0),
      maxSourceBytes: assets.reduce(
        (maximum, asset) => Math.max(maximum, asset.sourceBytes),
        0,
      ),
      sourceOutsideTempCount: insideTemp ? 0 : assets.length,
      nodeTauriHostBlockedCount: assets.length,
      formatBlockedCount: formatBlocked.size,
      nativeReadbackBlockedCount: readbackBlocked.size,
      formatOrReadbackBlockedCount: new Set([
        ...formatBlocked,
        ...readbackBlocked,
      ]).size,
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
        path: "desktop/src-tauri/src/commands/media.rs",
        symbol: "upload_media",
        fact: "requires an already-opened source beneath the OS temp directory",
      },
      {
        path: "desktop/src-tauri/src/commands/media_download.rs",
        symbol: "MAX_DOWNLOAD_BYTES",
        fact: "caps authenticated byte readback at 50 MiB",
      },
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
        path: "desktop/scripts/notion-import/desktopPublicationAdapter.ts",
        symbol: "createDesktopPublicationApi",
        fact: "binds Tauri renderer APIs while the journal executor uses Node filesystem APIs",
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
