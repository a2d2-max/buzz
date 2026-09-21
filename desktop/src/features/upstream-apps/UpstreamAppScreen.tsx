import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/shared/ui/button";
import {
  type UpstreamProduct,
  useUpstreamAppAvailability,
} from "./useUpstreamAppAvailability";

export type { UpstreamProduct } from "./useUpstreamAppAvailability";
let lifecycle: Promise<unknown> = Promise.resolve();
function enqueue<T>(command: string, args: Record<string, unknown>) {
  const pending = lifecycle
    .catch(() => undefined)
    .then(() => invoke<T>(command, args));
  lifecycle = pending;
  return pending;
}

/** Hosts the complete upstream product at its own first-party origin in the native window. */
export function UpstreamAppScreen({ product }: { product: UpstreamProduct }) {
  const host = React.useRef<HTMLDivElement>(null);
  const availability = useUpstreamAppAvailability();
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [session, retry] = React.useReducer(
    () => crypto.randomUUID(),
    null,
    () => crypto.randomUUID(),
  );
  const title = product === "affine" ? "AFFiNE Docs" : "Plane Board";
  const configured =
    availability.status === "ready" && availability.products.has(product);
  React.useEffect(() => {
    if (!configured) return;
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let frame = 0;
    let previous = "";
    let ready = false;
    setError(null);
    setChecking(true);
    const sync = () => {
      if (!ready) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width < 1 || height < 1) return;
        const hidden =
          document.hidden ||
          Boolean(
            document.querySelector(
              '[role="dialog"], [role="alertdialog"], [role="menu"]',
            ),
          );
        const args = {
          product,
          session,
          bounds: { x, y, width, height },
          hidden,
        };
        const signature = JSON.stringify(args);
        if (signature === previous) return;
        previous = signature;
        void enqueue("sync_upstream_app", args).catch((reason) => {
          if (!disposed) setError(String(reason));
        });
      });
    };
    const resize = new ResizeObserver(sync);
    resize.observe(element);
    const overlays = new MutationObserver(sync);
    overlays.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", sync);
    void enqueue<string>("probe_upstream_app", { product, session })
      .then((probedSession) => {
        if (disposed || probedSession !== session) return;
        ready = true;
        setChecking(false);
        sync();
      })
      .catch((reason) => {
        if (disposed) return;
        setChecking(false);
        setError(String(reason));
      });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", sync);
      document.removeEventListener("visibilitychange", sync);
      void enqueue("sync_upstream_app", {
        product,
        session,
        bounds: null,
        hidden: true,
      }).catch(console.error);
    };
  }, [configured, product, session]);
  const goBack = React.useCallback(() => {
    void enqueue("go_back_upstream_app", { session }).catch((reason) => {
      setError(String(reason));
    });
  }, [session]);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title}>
      <header className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <h1 className="text-base font-semibold">{title}</h1>
        <div className="flex items-center gap-2">
          <Button
            disabled={!configured || checking || Boolean(error)}
            variant="outline"
            size="sm"
            onClick={goBack}
          >
            Back
          </Button>
          <Button
            disabled={!configured}
            variant="outline"
            size="sm"
            onClick={retry}
          >
            Reload
          </Button>
        </div>
      </header>
      <div
        ref={host}
        className="relative min-h-0 flex-1"
        data-testid="upstream-app-host"
      >
        {availability.status === "loading" && (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Checking {title}…
          </p>
        )}
        {availability.status === "error" && (
          <div role="alert" className="p-6 text-sm">
            <p>Apps aren’t available right now.</p>
            <Button className="mt-4" onClick={availability.retry}>
              Try again
            </Button>
          </div>
        )}
        {availability.status === "ready" && !configured && (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            {title} isn’t available in this app.
          </p>
        )}
        {configured && checking && !error && (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Connecting to {title}…
          </p>
        )}
        {error && (
          <div role="alert" className="p-6 text-sm">
            <p>{title} could not be opened.</p>
            <p className="mt-2 text-muted-foreground">{error}</p>
            <Button className="mt-4" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
