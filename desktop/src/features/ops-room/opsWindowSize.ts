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

export interface OpsWindowHandle {
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

async function applyOpsWindowConfiguration(
  nativeWindow: OpsWindowHandle,
  evidenceSize: OpsEvidenceSize | null,
  isCurrent: () => boolean,
): Promise<void> {
  await nativeWindow
    .setMinSize(new LogicalSize(OPS_MINIMUM.width, OPS_MINIMUM.height))
    .catch(() => undefined);
  if (!isCurrent() || !evidenceSize) return;
  await nativeWindow
    .setSize(new LogicalSize(evidenceSize.width, evidenceSize.height))
    .catch(() => undefined);
}

async function restoreOpsWindow(nativeWindow: OpsWindowHandle): Promise<void> {
  await nativeWindow
    .setMinSize(new LogicalSize(DEFAULT_MINIMUM.width, DEFAULT_MINIMUM.height))
    .catch(() => undefined);
  await nativeWindow
    .setSize(new LogicalSize(DEFAULT_MINIMUM.width, DEFAULT_MINIMUM.height))
    .catch(() => undefined);
}

export async function configureOpsWindow(
  nativeWindow: OpsWindowHandle,
  evidenceSize: OpsEvidenceSize | null,
): Promise<() => Promise<void>> {
  await applyOpsWindowConfiguration(nativeWindow, evidenceSize, () => true);
  return () => restoreOpsWindow(nativeWindow);
}

export function useOpsWindowSize(
  nativeWindowOverride?: OpsWindowHandle,
  evidenceSizeOverride?: OpsEvidenceSize | null,
): void {
  const operationGenerationRef = React.useRef(0);
  const hasEvidenceSizeOverride = evidenceSizeOverride !== undefined;
  const evidenceWidth = evidenceSizeOverride?.width;
  const evidenceHeight = evidenceSizeOverride?.height;

  React.useEffect(() => {
    const nativeWindow = nativeWindowOverride ?? getCurrentWindow();
    const evidenceSize = hasEvidenceSizeOverride
      ? evidenceWidth === undefined || evidenceHeight === undefined
        ? null
        : { width: evidenceWidth, height: evidenceHeight }
      : configuredEvidenceSize();
    const setupGeneration = ++operationGenerationRef.current;

    const setup = applyOpsWindowConfiguration(
      nativeWindow,
      evidenceSize,
      () => operationGenerationRef.current === setupGeneration,
    );

    return () => {
      const cleanupGeneration = ++operationGenerationRef.current;
      queueMicrotask(() => {
        if (operationGenerationRef.current !== cleanupGeneration) return;
        void setup.then(() => {
          if (operationGenerationRef.current !== cleanupGeneration) return;
          return restoreOpsWindow(nativeWindow);
        });
      });
    };
  }, [
    evidenceHeight,
    evidenceWidth,
    hasEvidenceSizeOverride,
    nativeWindowOverride,
  ]);
}
