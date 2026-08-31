import * as React from "react";

import { cn } from "@/shared/lib/cn";
import type { VoiceTranscriptEntry } from "../lib/voiceConversationView.ts";

type VoiceTranscriptProps = {
  entries: VoiceTranscriptEntry[];
};

const ROLE_LABEL: Record<VoiceTranscriptEntry["role"], string> = {
  assistant: "RAOU",
  user: "You",
};

/**
 * The running conversation. Rendered as an ordered list so a screen reader
 * announces position and count, with the live partial kept in the same list
 * rather than a separate region — the reading order is the speaking order.
 */
export function VoiceTranscript({ entries }: VoiceTranscriptProps) {
  const endRef = React.useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  // One value that changes whenever the tail of the conversation grows — both
  // a new turn and a longer partial should pin the view to the bottom.
  const scrollKey =
    lastEntry === undefined
      ? null
      : `${entries.length}:${lastEntry.key}:${lastEntry.text.length}`;

  React.useEffect(() => {
    if (scrollKey === null) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [scrollKey]);

  if (entries.length === 0) {
    return (
      <p
        className="px-1 py-6 text-center text-sm text-muted-foreground"
        data-testid="voice-transcript-empty"
      >
        Your conversation will appear here.
      </p>
    );
  }

  return (
    <div>
      <ol
        className="flex flex-col gap-2 px-1"
        data-testid="voice-transcript"
        // The live region is the status bar; announcing the transcript too
        // would read every partial twice.
        aria-live="off"
      >
        {entries.map((entry) => (
          <li
            className={cn(
              "flex flex-col gap-0.5",
              entry.role === "user" ? "items-end" : "items-start",
            )}
            data-pending={entry.pending}
            data-role={entry.role}
            data-testid={`voice-turn-${entry.role}`}
            key={entry.key}
          >
            <span className="px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {ROLE_LABEL[entry.role]}
              {entry.interrupted ? " · interrupted" : null}
            </span>
            <span
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-1.5 text-message",
                entry.role === "user"
                  ? "bg-primary/10 text-foreground"
                  : "bg-muted/70 text-foreground",
                entry.pending && "opacity-70",
                entry.interrupted &&
                  "line-through decoration-muted-foreground/50",
              )}
            >
              {entry.text}
            </span>
          </li>
        ))}
      </ol>
      {/* Sentinel lives outside the list: <ol> may only contain <li>. */}
      <div aria-hidden="true" ref={endRef} />
    </div>
  );
}
