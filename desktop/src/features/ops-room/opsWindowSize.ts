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

interface OpsWindowCoordinator {
  activeOwners: Map<symbol, number>;
  currentOwner: symbol | null;
  generation: number;
  tail: Promise<void> | null;
}

const OPS_WINDOW_COORDINATORS = new WeakMap<
  OpsWindowHandle,
  OpsWindowCoordinator
>();
let currentOpsWindowHandle: OpsWindowHandle | null = null;

export function opsLayoutForWidth(width: number): OpsResponsiveLayout {
  if (width >= 1024) return "desktop";
  if (width >= 600) return "compact";
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

function resolveOpsWindow(
  nativeWindowOverride: OpsWindowHandle | undefined,
): OpsWindowHandle {
  if (nativeWindowOverride) return nativeWindowOverride;
  currentOpsWindowHandle ??= getCurrentWindow();
  return currentOpsWindowHandle;
}

function coordinatorFor(nativeWindow: OpsWindowHandle): OpsWindowCoordinator {
  const existing = OPS_WINDOW_COORDINATORS.get(nativeWindow);
  if (existing) return existing;
  const coordinator: OpsWindowCoordinator = {
    activeOwners: new Map(),
    currentOwner: null,
    generation: 0,
    tail: null,
  };
  OPS_WINDOW_COORDINATORS.set(nativeWindow, coordinator);
  return coordinator;
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
  queue: OpsWindowCoordinator,
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
  const ownerRef = React.useRef(Symbol("ops-window-owner"));
  const hasEvidenceSizeOverride = evidenceSizeOverride !== undefined;
  const evidenceWidth = evidenceSizeOverride?.width;
  const evidenceHeight = evidenceSizeOverride?.height;

  React.useEffect(() => {
    const nativeWindow = resolveOpsWindow(nativeWindowOverride);
    const coordinator = coordinatorFor(nativeWindow);
    const owner = ownerRef.current;
    const evidenceSize = hasEvidenceSizeOverride
      ? evidenceWidth === undefined || evidenceHeight === undefined
        ? null
        : { width: evidenceWidth, height: evidenceHeight }
      : configuredEvidenceSize();
    const setupGeneration = ++coordinator.generation;
    coordinator.activeOwners.set(owner, setupGeneration);
    coordinator.currentOwner = owner;

    void enqueueOpsWindowOperation(coordinator, () =>
      applyOpsWindowConfiguration(
        nativeWindow,
        evidenceSize,
        () =>
          coordinator.currentOwner === owner &&
          coordinator.activeOwners.get(owner) === setupGeneration,
      ),
    );

    return () => {
      if (coordinator.activeOwners.get(owner) === setupGeneration) {
        coordinator.activeOwners.delete(owner);
      }
      if (coordinator.currentOwner !== owner) return;

      let nextOwner: symbol | null = null;
      let nextGeneration = -1;
      for (const [activeOwner, generation] of coordinator.activeOwners) {
        if (generation > nextGeneration) {
          nextOwner = activeOwner;
          nextGeneration = generation;
        }
      }
      coordinator.currentOwner = nextOwner;
      if (nextOwner) return;

      const cleanupGeneration = ++coordinator.generation;
      queueMicrotask(() => {
        if (
          coordinator.generation !== cleanupGeneration ||
          coordinator.activeOwners.size > 0
        ) {
          return;
        }
        void enqueueOpsWindowOperation(coordinator, () => {
          if (
            coordinator.generation !== cleanupGeneration ||
            coordinator.activeOwners.size > 0
          ) {
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
