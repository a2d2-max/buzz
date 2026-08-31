import { rewriteRelayUrl } from "./mediaUrl";
import { useMediaRewriteRevision } from "./useMediaRewriteRevision";

/**
 * Rewrites a media URL reactively as the demand-started relay origin and proxy
 * port resolve. Until both are known the original URL remains intact, so cold
 * external Blossom images never receive a transient custom-scheme source.
 */
export function useRewrittenRelayUrl(url: string | null): string | null {
  const mediaRewriteRevision = useMediaRewriteRevision();
  // rewriteRelayUrl reads the media caches; revision is the explicit snapshot
  // identity that wakes this hook even when a reset still yields the same
  // canonical URL while the previous generation remains unresolved.
  void mediaRewriteRevision;
  return url ? rewriteRelayUrl(url) : null;
}
