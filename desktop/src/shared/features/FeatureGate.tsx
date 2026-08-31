import type { ReactNode } from "react";
import { useFeatureEnabled } from "./useFeatureEnabled";

interface FeatureGateProps {
  /** The feature id from the manifest */
  feature: string;
  /** Content to render when the feature is enabled */
  children: ReactNode;
  /** Optional fallback when the feature is disabled */
  fallback?: ReactNode;
  /** Product modes may promote a preview feature to a required surface. */
  forceEnabled?: boolean;
}

/**
 * Conditionally renders children based on whether a feature is enabled.
 *
 * Usage:
 *   <FeatureGate feature="workflows">
 *     <WorkflowsPanel />
 *   </FeatureGate>
 */
export function FeatureGate({
  feature,
  children,
  fallback = null,
  forceEnabled = false,
}: FeatureGateProps): ReactNode {
  const enabled = useFeatureEnabled(feature);
  return forceEnabled || enabled ? children : fallback;
}
