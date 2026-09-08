import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BlobDescriptor } from "../../src/shared/api/tauri.ts";
import type { RelayEvent } from "../../src/shared/api/types.ts";
import type { PublicationAssetBinding } from "./publicationBindings.ts";
import type { PublicationApi } from "./publicationExecutor.ts";
import type { UnsignedDocEvent } from "./types.ts";

type BuzzCliRunnerOptions = {
  maxBufferBytes: number;
  timeoutMs: number;
};

export type BuzzCliRunner = (
  executable: string,
  args: string[],
  options: BuzzCliRunnerOptions,
) => Promise<{ stdout: string }>;

const JSON_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_READBACK_BYTES = 500 * 1024 * 1024;

function defaultRunner(
  executable: string,
  args: string[],
  options: BuzzCliRunnerOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: options.maxBufferBytes,
        timeout: options.timeoutMs,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("publication-buzz-cli-command-failed"));
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

async function withPrivateJsonFile<T>(
  label: string,
  value: unknown,
  work: (filePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `buzz-notion-${label}-`),
  );
  const inputPath = path.join(directory, "input.json");
  try {
    await writeFile(inputPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return await work(inputPath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function parseJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error("publication-buzz-cli-invalid-json");
  }
}

function relayWebSocketUrl(value: string): string {
  let relay: URL;
  try {
    relay = new URL(value);
  } catch {
    throw new Error("publication-buzz-cli-invalid-identity");
  }
  if (
    (relay.protocol !== "http:" && relay.protocol !== "https:") ||
    relay.username !== "" ||
    relay.password !== "" ||
    (relay.pathname !== "" && relay.pathname !== "/") ||
    relay.search !== "" ||
    relay.hash !== ""
  ) {
    throw new Error("publication-buzz-cli-invalid-identity");
  }
  relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  return `${relay.protocol}//${relay.host}`;
}

type BuzzCliIdentity = { relay: string; pubkey: string };

/**
 * Node-compatible production adapter using the existing Buzz CLI transport.
 *
 * The child inherits its already-provisioned environment. This module never
 * reads, prints, or passes private-key/auth-tag values as command arguments.
 */
export function createBuzzCliPublicationApi({
  buzzCliPath,
  runner = defaultRunner,
}: {
  buzzCliPath: string;
  runner?: BuzzCliRunner;
}): PublicationApi {
  let identityPromise: Promise<BuzzCliIdentity> | null = null;

  async function runJson<T>(
    operation: string,
    args: string[],
    maxBufferBytes = JSON_MAX_BUFFER_BYTES,
    timeoutMs = 120_000,
  ): Promise<T> {
    let stdout: string;
    try {
      ({ stdout } = await runner(buzzCliPath, args, {
        maxBufferBytes,
        timeoutMs,
      }));
    } catch {
      throw new Error(`publication-buzz-cli-${operation}-failed`);
    }
    return parseJson<T>(stdout);
  }

  async function identity(): Promise<BuzzCliIdentity> {
    identityPromise ??= runJson<BuzzCliIdentity>(
      "identity",
      ["publication", "identity"],
      64 * 1024,
      30_000,
    ).then((result) => {
      if (
        typeof result.relay !== "string" ||
        !/^[0-9a-f]{64}$/.test(result.pubkey)
      ) {
        throw new Error("publication-buzz-cli-invalid-identity");
      }
      relayWebSocketUrl(result.relay);
      return result;
    });
    return identityPromise;
  }

  return {
    async getCurrentRelay() {
      return relayWebSocketUrl((await identity()).relay);
    },
    async getCurrentSignerPubkey() {
      return (await identity()).pubkey;
    },
    async uploadAsset(asset) {
      return runJson<BlobDescriptor>(
        "upload",
        ["upload", "file", "--file", asset.localPath],
        256 * 1024,
        660_000,
      );
    },
    async readAsset(binding: PublicationAssetBinding) {
      if (
        !Number.isSafeInteger(binding.remoteBytes) ||
        binding.remoteBytes <= 0 ||
        binding.remoteBytes > MAX_READBACK_BYTES
      ) {
        throw new Error("publication-buzz-cli-readback-size-invalid");
      }
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "buzz-notion-readback-"),
      );
      const outputPath = path.join(directory, "asset.bin");
      try {
        try {
          await runner(
            buzzCliPath,
            ["media", "get", binding.url, "--output", outputPath],
            { maxBufferBytes: 64 * 1024, timeoutMs: 420_000 },
          );
        } catch {
          throw new Error("publication-buzz-cli-readback-failed");
        }
        const metadata = await stat(outputPath);
        if (!metadata.isFile() || metadata.size !== binding.remoteBytes) {
          throw new Error("publication-buzz-cli-readback-size-mismatch");
        }
        return readFile(outputPath);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
    async queryDocVersions(pageId) {
      const result = await runJson<RelayEvent[]>("query", [
        "publication",
        "query-doc",
        "--page-id",
        pageId,
      ]);
      if (!Array.isArray(result)) {
        throw new Error("publication-buzz-cli-invalid-query");
      }
      return result;
    },
    async signEvent(input: UnsignedDocEvent) {
      return withPrivateJsonFile("sign", input, (inputPath) =>
        runJson<RelayEvent>("sign", [
          "publication",
          "sign-doc",
          "--input",
          inputPath,
        ]),
      );
    },
    async publishEvent(event: RelayEvent) {
      const response = await withPrivateJsonFile(
        "publish",
        event,
        (inputPath) =>
          runJson<{
            event_id: string;
            accepted: boolean;
            message: string;
          }>("publish", ["publication", "publish-doc", "--input", inputPath]),
      );
      return {
        eventId: response.event_id,
        accepted: response.accepted,
        message: response.message,
      };
    },
    nowSeconds() {
      return Math.floor(Date.now() / 1_000);
    },
  };
}
