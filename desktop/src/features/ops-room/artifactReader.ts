import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
  OpsBridgeContractError,
  readOpsArtifact,
  readOpsArtifactHandle,
  releaseOpsArtifactHandle,
  type OpsArtifactHandleChunk,
  type OpsArtifactReadRequest,
  type OpsArtifactReadResult,
} from "./opsBridge";

const HANDLE_CHUNK_BYTES = 256 * 1024;

export type OpsArtifactRepresentation = "rendered" | "preview";

export type OpsArtifactSelection = {
  id: string;
  title: string;
  kind: string;
  status: string;
  version: number;
  representation?: OpsArtifactRepresentation;
};

export type OpsArtifactLoadedContent =
  | {
      mime: OpsArtifactReadResult["mime"];
      source: "inline";
      text: string;
      totalSize: number;
    }
  | {
      blob: Blob;
      mime: OpsArtifactReadResult["mime"];
      source: "opaque";
      text: string;
      totalSize: number;
    };

export type OpsArtifactProgress = {
  loaded: number;
  total: number;
};

export type OpsArtifactReaderApi = {
  readArtifact(request: OpsArtifactReadRequest): Promise<OpsArtifactReadResult>;
  readHandle(request: {
    handle: string;
    offset: number;
    length: number;
  }): Promise<OpsArtifactHandleChunk>;
  releaseHandle(handle: string): Promise<{ released: boolean }>;
};

const nativeArtifactApi: OpsArtifactReaderApi = {
  readArtifact: readOpsArtifact,
  readHandle: readOpsArtifactHandle,
  releaseHandle: releaseOpsArtifactHandle,
};

export function artifactRepresentationForKind(
  kind: string,
): OpsArtifactRepresentation | null {
  const normalized = kind.trim().toLowerCase();
  if (
    ["image", "screenshot", "png", "jpg", "jpeg", "gif", "webp"].includes(
      normalized,
    )
  ) {
    return null;
  }
  return normalized === "html" ? "rendered" : "preview";
}

export function opsArtifactQueryKey(
  artifact: Pick<OpsArtifactSelection, "id" | "version">,
  representation: OpsArtifactRepresentation,
) {
  return [
    "ops",
    "artifact",
    artifact.id,
    artifact.version,
    representation,
  ] as const;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new OpsBridgeContractError();
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OpsBridgeContractError();
  }
}

export async function loadOpsArtifactText(
  artifact: OpsArtifactSelection,
  representation: OpsArtifactRepresentation,
  options: {
    api?: OpsArtifactReaderApi;
    onProgress?: (progress: OpsArtifactProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<OpsArtifactLoadedContent> {
  const api = options.api ?? nativeArtifactApi;
  throwIfAborted(options.signal);
  const result = await api.readArtifact({
    artifact_id: artifact.id,
    version: artifact.version,
    representation,
  });

  if (result.kind === "inline_text") {
    throwIfAborted(options.signal);
    options.onProgress?.({
      loaded: result.total_size,
      total: result.total_size,
    });
    return {
      mime: result.mime,
      source: "inline",
      text: result.text,
      totalSize: result.total_size,
    };
  }

  const { handle } = result;
  try {
    throwIfAborted(options.signal);
    if (result.total_size === 0) throw new OpsBridgeContractError();
    const bytes = new Uint8Array(result.total_size);
    let offset = 0;
    while (offset < result.total_size) {
      throwIfAborted(options.signal);
      const length = Math.min(HANDLE_CHUNK_BYTES, result.total_size - offset);
      const chunk = await api.readHandle({ handle, offset, length });
      throwIfAborted(options.signal);
      if (
        chunk.mime !== result.mime ||
        chunk.total_size !== result.total_size ||
        chunk.offset !== offset
      ) {
        throw new OpsBridgeContractError();
      }
      const decoded = decodeBase64(chunk.data_base64);
      if (decoded.byteLength !== chunk.next_offset - chunk.offset) {
        throw new OpsBridgeContractError();
      }
      bytes.set(decoded, offset);
      offset = chunk.next_offset;
      options.onProgress?.({ loaded: offset, total: result.total_size });
    }
    if (offset !== result.total_size) throw new OpsBridgeContractError();
    return {
      blob: new Blob([bytes.buffer], { type: result.mime }),
      mime: result.mime,
      source: "opaque",
      text: decodeUtf8(bytes),
      totalSize: result.total_size,
    };
  } finally {
    await api.releaseHandle(handle);
  }
}

export function useOpsArtifact(
  artifact: OpsArtifactSelection,
  loadArtifact: typeof loadOpsArtifactText = loadOpsArtifactText,
) {
  const representation =
    artifact.representation ?? artifactRepresentationForKind(artifact.kind);
  const [progress, setProgress] = React.useState<OpsArtifactProgress | null>(
    null,
  );
  const queryKey = representation
    ? opsArtifactQueryKey(artifact, representation)
    : (["ops", "artifact", artifact.id, artifact.version, "disabled"] as const);

  const query = useQuery({
    queryKey,
    enabled: representation !== null,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) => {
      if (!representation) throw new OpsBridgeContractError();
      return loadArtifact(artifact, representation, {
        signal,
        onProgress: setProgress,
      });
    },
  });

  return {
    ...query,
    progress: query.isPending ? progress : null,
    representation,
  };
}
