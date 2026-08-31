import { AudioLines } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { useHuddleVoiceChat } from "../hooks/useHuddleVoiceChat.ts";
import { VoiceConversationPanel } from "./VoiceConversationPanel.tsx";

type RaouVoiceDockProps = {
  className?: string;
};

/**
 * The RAOU voice chat entry point, docked above the huddle bar.
 *
 * It appears only once a huddle is running, because the conversation reuses
 * that audio session rather than opening one of its own.
 */
export function RaouVoiceDock({ className }: RaouVoiceDockProps) {
  const [expanded, setExpanded] = React.useState(false);
  const {
    available,
    close,
    open,
    pressPtt,
    releasePtt,
    retry,
    setInputMode,
    setMuted,
    state,
    view,
  } = useHuddleVoiceChat({ enabled: expanded });

  const handleOpen = React.useCallback(() => {
    setExpanded(true);
    open();
  }, [open]);

  const handleClose = React.useCallback(() => {
    close();
    setExpanded(false);
  }, [close]);

  // Losing the huddle takes the audio session with it. Close the conversation
  // too — a session left in `listening` would refuse the next `session/open`
  // and the panel would reopen onto a pipeline that is no longer there.
  React.useEffect(() => {
    if (available) return;
    setExpanded(false);
    close();
  }, [available, close]);

  if (!available) return null;

  if (!expanded) {
    return (
      <div className={cn("pointer-events-auto flex justify-end", className)}>
        <Button
          data-testid="voice-dock-launcher"
          onClick={handleOpen}
          size="sm"
          variant="secondary"
        >
          <AudioLines aria-hidden="true" />
          RAOU voice
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("pointer-events-auto flex justify-end", className)}>
      <VoiceConversationPanel
        className="max-h-[60vh] w-full max-w-md"
        inputMode={state.inputMode}
        micMuted={state.micMuted}
        onClose={handleClose}
        onOpen={open}
        onPressPtt={pressPtt}
        onReleasePtt={releasePtt}
        onRetry={retry}
        onSetInputMode={setInputMode}
        onSetMuted={setMuted}
        view={view}
      />
    </div>
  );
}
