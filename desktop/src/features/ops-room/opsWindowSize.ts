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

interface OpsWindowOperationQueue {
  tail: Promise<void> | null;
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
  if (!isCurrent()) return;
  await nativeWindow
    .setMinSize(new LogicalSize(OPS_MINIMUM.width, OPS_MINIMUM.height))
    .catch(() => undefined);
  if (!isCurrent() || !evidenceSize) return;
  await nativeWindow
    .setSize(new LogicalSize(evidenceSize.width, evidenceSize.height))
    .catch(() => undefined);
}

function enqueueOpsWindowOperation(
  queue: OpsWindowOperationQueue,
  operation: () => Promise<void>,
): Promise<void> {
  const queued = queue.tail
    ? queue.tail.then(operation, operation)
    : operation();
  const settled = queued.catch(() => undefined);
  queue.tail = settled;
  void settled.finally(() => {
    if (queue.tail === settled) queue.tail = null;
  });
  return settled;
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
  const operationQueueRef = React.useRef<OpsWindowOperationQueue>({
    tail: null,
  });
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

    void enqueueOpsWindowOperation(operationQueueRef.current, () =>
      applyOpsWindowConfiguration(
        nativeWindow,
        evidenceSize,
        () => operationGenerationRef.current === setupGeneration,
      ),
    );

    return () => {
      const cleanupGeneration = ++operationGenerationRef.current;
      queueMicrotask(() => {
        if (operationGenerationRef.current !== cleanupGeneration) return;
        void enqueueOpsWindowOperation(operationQueueRef.current, () => {
          if (operationGenerationRef.current !== cleanupGeneration) {
            return Promise.resolve();
          }
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
