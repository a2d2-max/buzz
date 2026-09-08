import {
  DOC_DEFAULT_MAX_CONTENT_BYTES,
  resolveMaxContentBytes,
} from "../../src/features/docs/lib/docContentLimit.ts";
import type { ContentLimitProvenance } from "./types.ts";

export const RELAY_INFO_TIMEOUT_MS = 5_000;
export const RELAY_INFO_MAX_RESPONSE_BYTES = 64 * 1024;

export type RelayContentLimitSource = "advertised" | "legacy-assumption";

export type RelayContentLimit = ContentLimitProvenance;

type ParsedRelayContentLimit = Pick<
  RelayContentLimit,
  | "advertisedMaxContentBytes"
  | "advertisedMaxMessageBytes"
  | "effectiveMaxContentBytes"
  | "reason"
  | "source"
>;

export class RelayContentLimitError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RelayContentLimitError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new RelayContentLimitError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseRelayContentLimit(
  document: unknown,
  legacyMaxContentBytes = DOC_DEFAULT_MAX_CONTENT_BYTES,
): ParsedRelayContentLimit {
  if (!validPositiveSafeInteger(legacyMaxContentBytes)) {
    fail("invalid-legacy-content-limit");
  }
  if (!isRecord(document)) fail("relay-info-invalid-document");
  if (!("limitation" in document) || document.limitation === null) {
    return {
      advertisedMaxContentBytes: null,
      effectiveMaxContentBytes: legacyMaxContentBytes,
      reason: "max-content-length-not-advertised",
      source: "legacy-assumption",
    };
  }
  if (!isRecord(document.limitation)) fail("relay-info-invalid-document");
  let advertisedMaxMessageBytes: number | undefined;
  if ("max_message_length" in document.limitation) {
    if (!validPositiveSafeInteger(document.limitation.max_message_length)) {
      fail("relay-info-invalid-max-message-length");
    }
    advertisedMaxMessageBytes = document.limitation.max_message_length;
  }
  if (!("max_content_length" in document.limitation)) {
    return {
      advertisedMaxContentBytes: null,
      ...(advertisedMaxMessageBytes === undefined
        ? {}
        : { advertisedMaxMessageBytes }),
      effectiveMaxContentBytes: legacyMaxContentBytes,
      reason: "max-content-length-not-advertised",
      source: "legacy-assumption",
    };
  }
  const advertised = document.limitation.max_content_length;
  if (!validPositiveSafeInteger(advertised)) {
    fail("relay-info-invalid-max-content-length");
  }
  return {
    advertisedMaxContentBytes: advertised,
    ...(advertisedMaxMessageBytes === undefined
      ? {}
      : { advertisedMaxMessageBytes }),
    effectiveMaxContentBytes: resolveMaxContentBytes(document),
    reason: "max-content-length-advertised",
    source: "advertised",
  };
}

function relayHttpUrl(relayUrl: string, pathname: "/" | "/info"): string {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return fail("invalid-relay-url");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return fail("invalid-relay-url");
  }
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function normalizedRelayOrigin(relayUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return fail("invalid-relay-url");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return fail("invalid-relay-url");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

async function readBoundedResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      fail("relay-info-invalid-content-length");
    }
    if (declared > maxResponseBytes) fail("relay-info-response-too-large");
  }
  if (!response.body) fail("relay-info-invalid-json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size reason is authoritative even if stream cancellation fails.
      }
      fail("relay-info-response-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("relay-info-invalid-utf8");
  }
}

async function fetchDocument(
  url: string,
  signal: AbortSignal,
  maxResponseBytes: number,
  fetchImpl: typeof fetch,
): Promise<{ document?: unknown; status: number; unsupported: boolean }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/nostr+json" },
      method: "GET",
      redirect: "manual",
      signal,
    });
  } catch (error) {
    if (signal.aborted) return fail("relay-info-timeout");
    if (error instanceof RelayContentLimitError) throw error;
    return fail("relay-info-network-failed");
  }
  if (response.status >= 300 && response.status < 400) {
    fail("relay-info-redirect-rejected");
  }
  if ([404, 405, 501].includes(response.status)) {
    return { status: response.status, unsupported: true };
  }
  if (!response.ok) fail("relay-info-http-error");
  let text: string;
  try {
    text = await readBoundedResponse(response, maxResponseBytes);
  } catch (error) {
    if (signal.aborted) return fail("relay-info-timeout");
    if (error instanceof RelayContentLimitError) throw error;
    return fail("relay-info-network-failed");
  }
  try {
    return {
      document: JSON.parse(text) as unknown,
      status: response.status,
      unsupported: false,
    };
  } catch {
    return fail("relay-info-invalid-json");
  }
}

export async function fetchRelayContentLimit(
  relayUrl: string,
  options: {
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetchImpl?: typeof fetch;
    legacyMaxContentBytes?: number;
    /** Explicit target whose successful advertisement is operational evidence. */
    operationalTargetRelay?: string;
  } = {},
): Promise<RelayContentLimit> {
  const timeoutMs = options.timeoutMs ?? RELAY_INFO_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? RELAY_INFO_MAX_RESPONSE_BYTES;
  if (!validPositiveSafeInteger(timeoutMs)) fail("invalid-relay-info-timeout");
  if (!validPositiveSafeInteger(maxResponseBytes)) {
    fail("invalid-relay-info-response-limit");
  }
  const relayOrigin = normalizedRelayOrigin(relayUrl);
  if (
    options.operationalTargetRelay !== undefined &&
    normalizedRelayOrigin(options.operationalTargetRelay) !== relayOrigin
  ) {
    fail("relay-info-operational-target-mismatch");
  }
  const infoUrl = relayHttpUrl(relayUrl, "/info");
  const rootUrl = relayHttpUrl(relayUrl, "/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const info = await fetchDocument(
      infoUrl,
      controller.signal,
      maxResponseBytes,
      options.fetchImpl ?? fetch,
    );
    let document = info.document;
    let relayInfoUrl = infoUrl;
    let relayInfoEndpoint: "/" | "/info" = "/info";
    let relayInfoHttpStatus = info.status;
    let unsupportedInfoEndpoint = false;
    if (info.unsupported) {
      unsupportedInfoEndpoint = true;
      const root = await fetchDocument(
        rootUrl,
        controller.signal,
        maxResponseBytes,
        options.fetchImpl ?? fetch,
      );
      if (root.unsupported) {
        const legacyMaxContentBytes =
          options.legacyMaxContentBytes ?? DOC_DEFAULT_MAX_CONTENT_BYTES;
        return {
          advertisedMaxContentBytes: null,
          effectiveMaxContentBytes: legacyMaxContentBytes,
          limitVerified: false,
          operationalAdvertisementConfirmed: false,
          reason: "relay-info-endpoint-unsupported",
          infoEndpointHttpStatus: info.status,
          relayInfoEndpoint: "/",
          relayInfoHttpStatus: root.status,
          relayInfoUrl: rootUrl,
          source: "legacy-assumption",
        };
      }
      document = root.document;
      relayInfoUrl = rootUrl;
      relayInfoEndpoint = "/";
      relayInfoHttpStatus = root.status;
    }
    const parsed = parseRelayContentLimit(
      document,
      options.legacyMaxContentBytes ?? DOC_DEFAULT_MAX_CONTENT_BYTES,
    );
    if (unsupportedInfoEndpoint && parsed.source === "legacy-assumption") {
      parsed.reason = "relay-info-endpoint-unsupported";
    }
    return {
      ...parsed,
      limitVerified: parsed.source === "advertised",
      operationalAdvertisementConfirmed:
        options.operationalTargetRelay !== undefined &&
        parsed.source === "advertised",
      relayInfoEndpoint,
      relayInfoHttpStatus,
      relayInfoUrl,
      infoEndpointHttpStatus: info.status,
    };
  } finally {
    clearTimeout(timer);
  }
}
