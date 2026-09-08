import { createHash } from "node:crypto";

import { collectMarkdownDestinations } from "./markdownDestinations.ts";
import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
} from "./publicationAssets.ts";
import type { NotionImport } from "./types.ts";

export type PublicationAssetBinding = {
  sourceSha256: string;
  sourceBytes: number;
  remoteSha256: string;
  remoteBytes: number;
  mime: string;
  url: string;
  uploadAccepted: boolean;
  readbackVerified: boolean;
};

export type PublicationAssetBindings = {
  version: 1;
  mode: "production" | "simulated";
  targetRelay: string;
  assets: PublicationAssetBinding[];
};

export type PublicationBindingStatus = {
  version: 1;
  targetRelay: string;
  bindingMode: "none" | "production" | "simulated";
  uploadAssetCount: number;
  boundAssetCount: number;
  totalReferenceCount: number;
  boundReferenceCount: number;
  unboundReferenceCount: number;
  referencesBound: boolean;
  productionBindingsComplete: boolean;
  assetBindingsComplete: boolean;
  readyForSigning: boolean;
  readyToPublish: false;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function relayHttpOrigin(relay: string): string {
  let parsed: URL;
  try {
    parsed = new URL(relay);
  } catch {
    throw new Error("publication-binding-invalid-relay");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("publication-binding-invalid-relay");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    parsed.protocol === "ws:" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1"
  ) {
    throw new Error("publication-binding-insecure-production-relay");
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.origin;
}

function validateBinding(
  binding: PublicationAssetBinding,
  expected: PublicPublicationAssetManifest["uploadAssets"][number],
  mode: PublicationAssetBindings["mode"],
  targetOrigin: string,
  requireReadback = true,
): void {
  if (
    binding.sourceSha256 !== expected.sourceSha256 ||
    binding.sourceBytes !== expected.bytes
  ) {
    throw new Error("publication-binding-source-mismatch");
  }
  if (
    !validHash(binding.remoteSha256) ||
    !Number.isSafeInteger(binding.remoteBytes) ||
    binding.remoteBytes <= 0 ||
    typeof binding.mime !== "string" ||
    binding.mime.length === 0
  ) {
    throw new Error("publication-binding-invalid-descriptor");
  }
  let url: URL;
  try {
    url = new URL(binding.url);
  } catch {
    throw new Error("publication-binding-invalid-url");
  }
  const mediaName = url.pathname.startsWith("/media/")
    ? url.pathname.slice("/media/".length)
    : "";
  if (!new RegExp(`^${binding.remoteSha256}\\.[A-Za-z0-9]+$`).test(mediaName)) {
    throw new Error("publication-binding-hash-url-mismatch");
  }
  if (mode === "production") {
    if (
      binding.remoteSha256 !== expected.sourceSha256 ||
      binding.remoteBytes !== expected.bytes ||
      url.origin !== targetOrigin ||
      (url.protocol !== "https:" && !targetOrigin.startsWith("http://")) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("publication-binding-production-url-mismatch");
    }
    if (!binding.uploadAccepted) {
      throw new Error("publication-binding-upload-not-accepted");
    }
    if (requireReadback && !binding.readbackVerified) {
      throw new Error("publication-binding-readback-not-verified");
    }
  }
}

/** Validate an accepted descriptor before any adapter follows its readback URL. */
export function validateUploadedPublicationAsset({
  binding,
  expected,
  targetRelay,
}: {
  binding: PublicationAssetBinding;
  expected: PublicPublicationAssetManifest["uploadAssets"][number];
  targetRelay: string;
}): void {
  validateBinding(
    binding,
    expected,
    "production",
    relayHttpOrigin(targetRelay),
    false,
  );
}

/** Bind uploaded URLs strictly at manifest-owned Markdown destinations. */
export function bindPublicationAssetUrls({
  imported,
  privateManifest,
  publicManifest,
  bindings,
}: {
  imported: NotionImport;
  privateManifest: PrivatePublicationAssetManifest;
  publicManifest: PublicPublicationAssetManifest;
  bindings: PublicationAssetBindings;
}): {
  imported: NotionImport;
  status: PublicationBindingStatus;
  bindings: PublicationAssetBindings;
} {
  if (bindings.version !== 1)
    throw new Error("publication-binding-invalid-version");
  const targetOrigin = relayHttpOrigin(bindings.targetRelay);
  const expectedByHash = new Map(
    publicManifest.uploadAssets.map((asset) => [asset.sourceSha256, asset]),
  );
  const bindingsByHash = new Map<string, PublicationAssetBinding>();
  for (const binding of bindings.assets) {
    if (bindingsByHash.has(binding.sourceSha256)) {
      throw new Error("publication-binding-duplicate-source");
    }
    const expected = expectedByHash.get(binding.sourceSha256);
    if (!expected) throw new Error("publication-binding-unknown-source");
    validateBinding(binding, expected, bindings.mode, targetOrigin);
    bindingsByHash.set(binding.sourceSha256, binding);
  }

  const prepared = structuredClone(imported);
  const mappingByPage = new Map(
    privateManifest.pages.map((mapping) => [mapping.pageId, mapping]),
  );
  const referencesByPlaceholder = new Map(
    privateManifest.references.map((reference) => [
      reference.placeholder,
      reference,
    ]),
  );
  let boundReferenceCount = 0;
  for (const page of prepared.pages) {
    const mapping = mappingByPage.get(page.id);
    if (mapping && sha256(page.body) !== mapping.preparedBodySha256) {
      throw new Error("publication-binding-prepared-body-mismatch");
    }
    const replacements: Array<{ start: number; end: number; url: string }> = [];
    for (const destination of collectMarkdownDestinations(page.body)) {
      const reference = referencesByPlaceholder.get(destination.url);
      if (!reference) continue;
      if (reference.pageId !== page.id) {
        throw new Error("publication-binding-reference-page-mismatch");
      }
      const binding = bindingsByHash.get(reference.sourceSha256);
      if (!binding) continue;
      replacements.push({
        start: destination.start,
        end: destination.end,
        url: binding.url,
      });
      boundReferenceCount += 1;
    }
    for (const replacement of replacements.sort(
      (left, right) => right.start - left.start,
    )) {
      page.body =
        page.body.slice(0, replacement.start) +
        replacement.url +
        page.body.slice(replacement.end);
    }
  }
  const totalReferenceCount = privateManifest.references.length;
  const unboundReferenceCount = totalReferenceCount - boundReferenceCount;
  const referencesBound = unboundReferenceCount === 0;
  const boundAssetCount = bindingsByHash.size;
  const everyAssetBound =
    boundAssetCount === publicManifest.uploadAssets.length;
  const productionBindingsComplete =
    bindings.mode === "production" && referencesBound && everyAssetBound;
  return {
    imported: prepared,
    bindings,
    status: {
      version: 1,
      targetRelay: bindings.targetRelay,
      bindingMode: bindings.mode,
      uploadAssetCount: publicManifest.uploadAssets.length,
      boundAssetCount,
      totalReferenceCount,
      boundReferenceCount,
      unboundReferenceCount,
      referencesBound,
      productionBindingsComplete,
      assetBindingsComplete: productionBindingsComplete,
      readyForSigning: productionBindingsComplete,
      readyToPublish: false,
    },
  };
}
