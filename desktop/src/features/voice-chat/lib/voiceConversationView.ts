import {
  isMicOpen,
  isSessionActive,
  type VoiceConversationState,
  type VoiceConversationStatus,
} from "./voiceConversationMachine.ts";

export type VoiceTone = "accent" | "active" | "danger" | "neutral";

export interface VoiceTranscriptEntry {
  /** True when this entry was cut off by a barge-in. */
  interrupted: boolean;
  /** Stable across renders so React does not remount a growing partial. */
  key: string;
  /** True while the words are still arriving. */
  pending: boolean;
  role: "assistant" | "user";
  text: string;
}

export interface VoiceMicButtonView {
  disabled: boolean;
  label: string;
  /** Drives `aria-pressed` — it tracks the live microphone, not the key. */
  pressed: boolean;
}

export interface VoiceConversationView {
  announcement: string;
  announcementPoliteness: "assertive" | "polite";
  canRetry: boolean;
  hint: string;
  label: string;
  micButton: VoiceMicButtonView;
  micOpen: boolean;
  status: VoiceConversationStatus;
  tone: VoiceTone;
  transcript: VoiceTranscriptEntry[];
}

/** Key for the in-flight user partial — constant so the entry is never remounted. */
const LIVE_USER_KEY = "voice-live-user";

const STATUS_COPY: Record<
  VoiceConversationStatus,
  { hint: string; label: string; tone: VoiceTone }
> = {
  capturing: {
    hint: "Keep going — your words are being transcribed.",
    label: "Hearing you",
    tone: "active",
  },
  connecting: {
    hint: "Getting the microphone and voice pipeline ready.",
    label: "Connecting",
    tone: "neutral",
  },
  error: {
    hint: "Voice chat stopped unexpectedly.",
    label: "Voice chat stopped",
    tone: "danger",
  },
  idle: {
    hint: "Start a voice conversation when you are ready.",
    label: "Voice chat off",
    tone: "neutral",
  },
  listening: {
    hint: "Ready when you are.",
    label: "Listening",
    tone: "accent",
  },
  responding: {
    hint: "Speak any time to interrupt.",
    label: "Speaking",
    tone: "active",
  },
  thinking: {
    hint: "Working on a reply.",
    label: "Thinking",
    tone: "accent",
  },
};

function describeMicButton(state: VoiceConversationState): VoiceMicButtonView {
  const open = isMicOpen(state);
  if (state.inputMode === "hands_free") {
    return {
      disabled: !isSessionActive(state),
      label: state.micMuted ? "Unmute microphone" : "Mute microphone",
      pressed: open,
    };
  }
  return {
    disabled: !isSessionActive(state),
    label: open ? "Release to send" : "Hold to talk",
    pressed: open,
  };
}

function buildTranscript(
  state: VoiceConversationState,
): VoiceTranscriptEntry[] {
  const entries: VoiceTranscriptEntry[] = state.turns.map((turn) => ({
    interrupted: turn.interrupted,
    key: turn.id,
    pending: false,
    role: turn.role,
    text: turn.text,
  }));
  if (state.activeResponseId !== null && state.assistantDraft.length > 0) {
    entries.push({
      interrupted: false,
      key: `a${state.activeResponseId}`,
      pending: true,
      role: "assistant",
      text: state.assistantDraft,
    });
  }
  if (state.liveTranscript !== null) {
    entries.push({
      interrupted: false,
      key: LIVE_USER_KEY,
      pending: !state.liveTranscript.isFinal,
      role: "user",
      text: state.liveTranscript.text,
    });
  }
  return entries;
}

/**
 * Everything the voice surface renders, derived from the machine state.
 *
 * Keeping this a pure function means the accessible names, the live-region
 * politeness, and the transcript ordering are all covered by unit tests rather
 * than only by whatever a screenshot happens to show.
 */
export function describeVoiceConversation(
  state: VoiceConversationState,
): VoiceConversationView {
  const copy = STATUS_COPY[state.status];
  const failed = state.status === "error";
  const hint = failed && state.error ? state.error.message : copy.hint;
  return {
    announcement: failed ? `${copy.label}: ${hint}` : copy.label,
    announcementPoliteness: failed ? "assertive" : "polite",
    canRetry: failed,
    hint,
    label: copy.label,
    micButton: describeMicButton(state),
    micOpen: isMicOpen(state),
    status: state.status,
    tone: copy.tone,
    transcript: buildTranscript(state),
  };
}
