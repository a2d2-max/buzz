import * as React from "react";

import { getMediaRewriteRevision, subscribeMediaRewrite } from "./mediaUrl";

/** Re-render memoized media derivations when origin, proxy, or generation moves. */
export function useMediaRewriteRevision(): number {
  return React.useSyncExternalStore(
    subscribeMediaRewrite,
    getMediaRewriteRevision,
    () => 0,
  );
}
