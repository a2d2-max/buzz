import * as React from "react";

import { useRewrittenRelayUrl } from "@/shared/lib/useRewrittenRelayUrl";
import { SimpleImageLightbox } from "@/shared/ui/SimpleImageLightbox";

export function ViewImageToolPreview({
  src,
  title,
}: {
  src: string;
  title: string | null;
}) {
  const [lightboxOpen, setLightboxOpen] = React.useState(false);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const resolvedSrc = useRewrittenRelayUrl(src) ?? src;
  const alt = title ?? "Viewed image";

  if (failedSrc === resolvedSrc) {
    return null;
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: opens lightbox on click */}
      <img
        alt={alt}
        className="ml-1.5 block max-h-64 max-w-[min(24rem,calc(100%-0.375rem))] cursor-pointer rounded-lg object-contain"
        decoding="async"
        loading="lazy"
        onClick={() => setLightboxOpen(true)}
        onError={() => setFailedSrc(resolvedSrc)}
        src={resolvedSrc}
        title={title ?? undefined}
      />
      <SimpleImageLightbox
        alt={alt}
        onOpenChange={setLightboxOpen}
        open={lightboxOpen}
        src={resolvedSrc}
      />
    </>
  );
}
