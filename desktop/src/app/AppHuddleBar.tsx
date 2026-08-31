import type * as React from "react";

import { HuddleBar } from "@/features/huddle";
import { RaouVoiceDock } from "@/features/voice-chat";

import { AppProfilePanelProvider } from "@/app/AppProfilePanelProvider";

type AppHuddleBarProps = Pick<
  React.ComponentProps<typeof HuddleBar>,
  "mode" | "onOpenHuddleWindow" | "onOpenThread" | "onVisibilityChange"
>;

export function AppHuddleBar({
  mode,
  onOpenHuddleWindow,
  onOpenThread,
  onVisibilityChange,
}: AppHuddleBarProps) {
  return (
    <AppProfilePanelProvider>
      {/*
        The voice dock floats just above the drawer rather than inside the bar,
        so the huddle controls keep their own layout and hit targets.
      */}
      <RaouVoiceDock className="absolute inset-x-0 bottom-full z-20 px-3 pb-2" />
      <HuddleBar
        className="h-full"
        mode={mode}
        onOpenHuddleWindow={onOpenHuddleWindow}
        onOpenThread={onOpenThread}
        onVisibilityChange={onVisibilityChange}
      />
    </AppProfilePanelProvider>
  );
}
