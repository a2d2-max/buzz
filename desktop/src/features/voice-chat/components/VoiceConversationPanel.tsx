import { Loader2, Mic, MicOff, PhoneOff, RotateCcw } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import type { VoiceInputMode } from "../lib/voiceConversationMachine.ts";
import type {
  VoiceConversationView,
  VoiceTone,
} from "../lib/voiceConversationView.ts";
import { VoiceTranscript } from "./VoiceTranscript.tsx";

type VoiceConversationPanelProps = {
  className?: string;
  inputMode: VoiceInputMode;
  micMuted: boolean;
  onClose: () => void;
  onOpen: () => void;
  onPressPtt: () => void;
  onReleasePtt: () => void;
  onRetry: () => void;
  onSetInputMode: (mode: VoiceInputMode) => void;
  onSetMuted: (muted: boolean) => void;
  view: VoiceConversationView;
};

const TONE_DOT: Record<VoiceTone, string> = {
  accent: "bg-primary",
  active: "bg-primary animate-pulse",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/50",
};

const MODE_OPTIONS: { label: string; mode: VoiceInputMode }[] = [
  { label: "Hold to talk", mode: "push_to_talk" },
  { label: "Hands free", mode: "hands_free" },
];

/**
 * The RAOU voice surface: status, transcript, and the controls that drive the
 * conversation machine. It renders from `view` alone, so every accessible name
 * it shows is the one covered by `voiceConversationView.test.mjs`.
 */
export function VoiceConversationPanel({
  className,
  inputMode,
  micMuted,
  onClose,
  onOpen,
  onPressPtt,
  onReleasePtt,
  onRetry,
  onSetInputMode,
  onSetMuted,
  view,
}: VoiceConversationPanelProps) {
  const isOff = view.status === "idle";
  const isPushToTalk = inputMode === "push_to_talk";

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!isPushToTalk) return;
      // Capture the pointer so releasing outside the button still ends the turn.
      event.currentTarget.setPointerCapture(event.pointerId);
      onPressPtt();
    },
    [isPushToTalk, onPressPtt],
  );

  const handlePointerUp = React.useCallback(() => {
    if (!isPushToTalk) return;
    onReleasePtt();
  }, [isPushToTalk, onReleasePtt]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!isPushToTalk || (event.key !== " " && event.key !== "Enter")) return;
      // Suppress scrolling and the synthetic click a released key would fire.
      event.preventDefault();
      if (event.repeat) return;
      onPressPtt();
    },
    [isPushToTalk, onPressPtt],
  );

  const handleKeyUp = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!isPushToTalk || (event.key !== " " && event.key !== "Enter")) return;
      event.preventDefault();
      onReleasePtt();
    },
    [isPushToTalk, onReleasePtt],
  );

  const handleClick = React.useCallback(() => {
    if (isPushToTalk) return;
    onSetMuted(!micMuted);
  }, [isPushToTalk, micMuted, onSetMuted]);

  return (
    <section
      aria-label="RAOU voice chat"
      className={cn(
        "flex min-h-0 flex-col gap-3 rounded-xl border border-input/40 bg-background/95 p-3 shadow-lg",
        className,
      )}
      data-status={view.status}
      data-testid="voice-conversation-panel"
    >
      <header className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", TONE_DOT[view.tone])}
        />
        <div className="flex min-w-0 flex-col">
          <span
            className="truncate text-sm font-medium"
            data-testid="voice-status-label"
          >
            {view.label}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {view.hint}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {view.canRetry ? (
            <Button
              data-testid="voice-retry"
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              <RotateCcw aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          {isOff ? (
            <Button data-testid="voice-start" onClick={onOpen} size="sm">
              <Mic aria-hidden="true" />
              Start voice chat
            </Button>
          ) : (
            <Button
              aria-label="End voice chat"
              data-testid="voice-end"
              onClick={onClose}
              size="sm"
              variant="ghost"
            >
              <PhoneOff aria-hidden="true" />
              End
            </Button>
          )}
        </div>
      </header>

      {/*
        The single live region for the whole surface. It carries only the
        settled status so partial transcripts do not flood a screen reader.
      */}
      <p
        aria-live={view.announcementPoliteness}
        className="sr-only"
        data-testid="voice-live-region"
        role="status"
      >
        {view.announcement}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <VoiceTranscript entries={view.transcript} />
      </div>

      <div className="flex items-center gap-2">
        <Button
          aria-label={view.micButton.label}
          aria-pressed={view.micButton.pressed}
          className={cn(
            "flex-1 touch-none select-none",
            view.micButton.pressed && "ring-1 ring-ring",
          )}
          data-testid="voice-mic-button"
          disabled={view.micButton.disabled}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onPointerCancel={handlePointerUp}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          variant={view.micButton.pressed ? "default" : "outline"}
        >
          {view.status === "connecting" ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : view.micOpen ? (
            <Mic aria-hidden="true" />
          ) : (
            <MicOff aria-hidden="true" />
          )}
          {view.micButton.label}
        </Button>

        <fieldset className="flex shrink-0 items-center gap-1 rounded-lg border border-input/40 p-0.5">
          <legend className="sr-only">Voice input mode</legend>
          {MODE_OPTIONS.map((option) => (
            <Button
              aria-pressed={inputMode === option.mode}
              data-testid={`voice-mode-${option.mode}`}
              key={option.mode}
              onClick={() => onSetInputMode(option.mode)}
              size="xs"
              variant={inputMode === option.mode ? "secondary" : "ghost"}
            >
              {option.label}
            </Button>
          ))}
        </fieldset>
      </div>
    </section>
  );
}
