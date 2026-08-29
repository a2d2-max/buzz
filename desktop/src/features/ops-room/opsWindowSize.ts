import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as React from "react";

const OPS_MINIMUM = { width: 360, height: 500 } as const;
const DEFAULT_MINIMUM = { width: 800, height: 500 } as const;

export type OpsResponsiveLayout = "desktop" | "compact" | "mobile";

export interface OpsEvidenceSize {
  width: number;
  height: number;
}

interface OpsWindowHandle {
  setMinSize(size: LogicalSize): Promise<void>;
  setSize(size: LogicalSize): Promise<void>;
}

interface OpsEvidenceEnvironment {
  VITE_OPS_EVIDENCE_WIDTH?: string;
  VITE_OPS_EVIDENCE_HEIGHT?: string;
}

export function opsLayoutForWidth(width: number): OpsResponsiveLayout {
  if (width >= 1024) return "desktop";
  if (width >= 640) return "compact";
  return "mobile";
}

export function readOpsEvidenceSize(
  environment: OpsEvidenceEnvironment,
  development: boolean,
): OpsEvidenceSize | null {
  if (!development) return null;
  const width = Number(environment.VITE_OPS_EVIDENCE_WIDTH);
  const height = Number(environment.VITE_OPS_EVIDENCE_HEIGHT);
  if (!Number.isInteger(width) || width < 360 || width > 1600) return null;
  if (!Number.isInteger(height) || height < 500 || height > 1200) return null;
  return { width, height };
}

function configuredEvidenceSize(): OpsEvidenceSize | null {
  return readOpsEvidenceSize(
    {
      VITE_OPS_EVIDENCE_WIDTH: import.meta.env?.VITE_OPS_EVIDENCE_WIDTH,
      VITE_OPS_EVIDENCE_HEIGHT: import.meta.env?.VITE_OPS_EVIDENCE_HEIGHT,
    },
    import.meta.env?.DEV === true,
  );
}

export async function configureOpsWindow(
  nativeWindow: OpsWindowHandle,
  evidenceSize: OpsEvidenceSize | null,
): Promise<() => Promise<void>> {
  await nativeWindow
    .setMinSize(new LogicalSize(OPS_MINIMUM.width, OPS_MINIMUM.height))
    .catch(() => undefined);
  if (evidenceSize) {
    await nativeWindow
      .setSize(new LogicalSize(evidenceSize.width, evidenceSize.height))
      .catch(() => undefined);
  }

  return async () => {
    await nativeWindow
      .setMinSize(
        new LogicalSize(DEFAULT_MINIMUM.width, DEFAULT_MINIMUM.height),
      )
      .catch(() => undefined);
    await nativeWindow
      .setSize(new LogicalSize(DEFAULT_MINIMUM.width, DEFAULT_MINIMUM.height))
      .catch(() => undefined);
  };
}

export function useOpsWindowSize(): void {
  React.useEffect(() => {
    let disposed = false;
    let restore: (() => Promise<void>) | null = null;

    void configureOpsWindow(getCurrentWindow(), configuredEvidenceSize()).then(
      (cleanup) => {
        if (disposed) {
          void cleanup();
          return;
        }
        restore = cleanup;
      },
    );

    return () => {
      disposed = true;
      if (restore) void restore();
    };
  }, []);
}
