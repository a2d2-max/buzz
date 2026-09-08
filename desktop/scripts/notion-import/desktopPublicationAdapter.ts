import {
  COMMUNITY_DOC_QUERY_KINDS,
  docPageDTag,
} from "../../src/features/docs/lib/docPageCodec.ts";
import { relayClient } from "../../src/shared/api/relayClient.ts";
import {
  getRelayWsUrl,
  signRelayEvent,
  uploadMedia,
} from "../../src/shared/api/tauri.ts";
import { getIdentity } from "../../src/shared/api/tauriIdentity.ts";
import { fetchMediaBytes } from "../../src/shared/api/tauriMedia.ts";
import type { PublicationApi } from "./publicationExecutor.ts";

/**
 * Source-level binding for Buzz Desktop's existing identity, Blossom, and
 * authenticated relay session. This module requires a Tauri renderer host,
 * while the current executor requires Node filesystem APIs; the importer does
 * not yet provide a shared execution host between them. `executePublication`
 * still keeps every call behind its exact target/signer/live-authorization
 * gate.
 *
 * `upload_media` accepts only a source already staged in the OS temp
 * directory. `fetch_media_bytes` currently caps readback at 50 MiB; larger
 * retained files remain incomplete until an existing bounded readback API can
 * verify them.
 */
export function createDesktopPublicationApi(): PublicationApi {
  return {
    getCurrentRelay: getRelayWsUrl,
    async getCurrentSignerPubkey() {
      return (await getIdentity()).pubkey;
    },
    async uploadAsset(asset) {
      return uploadMedia(asset.localPath, false);
    },
    async readAsset(binding) {
      return fetchMediaBytes(binding.url);
    },
    async queryDocVersions(pageId) {
      return relayClient.fetchEvents({
        kinds: [...COMMUNITY_DOC_QUERY_KINDS],
        "#d": [docPageDTag(pageId)],
        limit: 100,
      });
    },
    signEvent: signRelayEvent,
    async publishEvent(event) {
      await relayClient.publishEvent(
        event,
        "Timed out publishing the imported page.",
        "Failed to publish the imported page.",
      );
      return { eventId: event.id, accepted: true, message: "" };
    },
    nowSeconds() {
      return Math.floor(Date.now() / 1_000);
    },
  };
}
