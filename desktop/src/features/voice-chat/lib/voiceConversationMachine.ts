/**
 * Pure state machine for a RAOU realtime voice conversation.
 *
 * The reducer never touches Tauri, the relay, or an audio device. It maps an
 * event onto the next state plus a list of *effects* — descriptions of what the
 * host should do (`start-pipeline`, `set-mic-open`, `stop-playback`, …). The
 * adapter that owns the real Huddle pipeline interprets them, which keeps the
 * whole conversation lifecycle testable without any hardware or provider.
 */

/**
 * How the microphone is armed. `hands_free` is the voice-activity mode the
 * Huddle backend calls `voice_activity`; the adapter maps between the two.
 */
export type VoiceInputMode = "push_to_talk" | "hands_free";

export type VoiceConversationStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "capturing"
  | "thinking"
  | "responding"
  | "error";

/** Where the assistant's spoken reply is in its playback lifecycle. */
export type AssistantPlaybackStatus = "idle" | "speaking" | "interrupted";

export type VoiceErrorCode =
  | "pipeline_unavailable"
  | "mic_unavailable"
  | "transcription_failed"
  | "assistant_failed"
  | "tts_failed";

export interface VoiceConversationError {
  code: VoiceErrorCode;
  message: string;
}

export interface VoiceTurn {
  id: string;
  /** True when the user barged in before this turn finished speaking. */
  interrupted: boolean;
  role: "assistant" | "user";
  text: string;
}

export interface VoiceLiveTranscript {
  isFinal: boolean;
  text: string;
}

export interface VoiceConversationState {
  /** Response id of the reply currently streaming or playing, if any. */
  activeResponseId: number | null;
  assistantDraft: string;
  assistantPlayback: AssistantPlaybackStatus;
  error: VoiceConversationError | null;
  inputMode: VoiceInputMode;
  /** True between `assistant/stream-start` and `assistant/stream-end`. */
  isStreaming: boolean;
  liveTranscript: VoiceLiveTranscript | null;
  /** The user's explicit mute, independent of the input mode. */
  micMuted: boolean;
  pttHeld: boolean;
  status: VoiceConversationStatus;
  turns: VoiceTurn[];
}

export type VoiceConversationEvent =
  | { type: "session/open" }
  | { type: "session/ready" }
  | { type: "session/close" }
  | { type: "input-mode/set"; mode: VoiceInputMode }
  | { type: "mic/set-muted"; muted: boolean }
  | { type: "ptt/press" }
  | { type: "ptt/release" }
  | { type: "speech/detected" }
  | { type: "transcript/partial"; text: string }
  | { type: "transcript/final"; text: string; turnId: string }
  | { type: "assistant/stream-start"; responseId: number }
  | { type: "assistant/stream-delta"; text: string }
  | { type: "assistant/stream-end" }
  | { type: "playback/started" }
  | { type: "playback/ended" }
  | { type: "error"; error: VoiceConversationError }
  | { type: "retry" };

export type VoiceConversationEffect =
  | { type: "start-pipeline" }
  | { type: "stop-pipeline" }
  | { type: "set-mic-open"; open: boolean }
  | { type: "set-input-mode"; mode: VoiceInputMode }
  | { type: "submit-utterance"; text: string; turnId: string }
  | { type: "stop-playback"; responseId: number };

export interface VoiceConversationResult {
  effects: VoiceConversationEffect[];
  state: VoiceConversationState;
}

/**
 * A transition proposed by one event. `effects` run before the derived
 * `set-mic-open`, `tailEffects` after it — the ordering the pipeline needs when
 * closing down (stop playback, close the mic, then stop the pipeline).
 * `null` means "this event does not apply here".
 */
type VoiceTransition = {
  effects?: VoiceConversationEffect[];
  state: VoiceConversationState;
  tailEffects?: VoiceConversationEffect[];
} | null;

export function createVoiceConversationState(): VoiceConversationState {
  return {
    activeResponseId: null,
    assistantDraft: "",
    assistantPlayback: "idle",
    error: null,
    inputMode: "push_to_talk",
    isStreaming: false,
    liveTranscript: null,
    micMuted: false,
    pttHeld: false,
    status: "idle",
    turns: [],
  };
}

/** True once the pipeline is running and can carry audio in either direction. */
export function isSessionActive(state: VoiceConversationState): boolean {
  return (
    state.status === "listening" ||
    state.status === "capturing" ||
    state.status === "thinking" ||
    state.status === "responding"
  );
}

/**
 * Whether the microphone should currently be transmitting.
 *
 * Derived, never stored, and it mirrors the Huddle rule: a held push-to-talk
 * key temporarily opens a manually muted microphone, while hands-free never
 * overrides that mute.
 */
export function isMicOpen(state: VoiceConversationState): boolean {
  if (!isSessionActive(state)) return false;
  if (state.pttHeld) return true;
  return state.inputMode === "hands_free" && !state.micMuted;
}

/** True while the assistant is producing or speaking a reply. */
export function isAssistantBusy(state: VoiceConversationState): boolean {
  return state.status === "thinking" || state.status === "responding";
}

function assistantTurnId(responseId: number): string {
  return `a${responseId}`;
}

type Interruption = {
  effects: VoiceConversationEffect[];
  patch: Partial<VoiceConversationState>;
};

const NO_INTERRUPTION: Interruption = { effects: [], patch: {} };

/**
 * Cancel the in-flight reply. Whatever the assistant had already said is kept
 * as an `interrupted` turn so the transcript shows where it was cut off, and
 * `activeResponseId` is cleared so late deltas from the cancelled response are
 * dropped instead of leaking into the next turn.
 */
function interruptAssistant(state: VoiceConversationState): Interruption {
  const responseId = state.activeResponseId;
  if (responseId === null) return NO_INTERRUPTION;
  const spoken = state.assistantDraft.trim();
  return {
    effects: [{ responseId, type: "stop-playback" }],
    patch: {
      activeResponseId: null,
      assistantDraft: "",
      assistantPlayback: "interrupted",
      isStreaming: false,
      turns:
        spoken.length > 0
          ? [
              ...state.turns,
              {
                id: assistantTurnId(responseId),
                interrupted: true,
                role: "assistant",
                text: spoken,
              },
            ]
          : state.turns,
    },
  };
}

/**
 * Capture cannot outlive an open microphone. `dropTranscript` separates an
 * explicit "discard what I was saying" gesture (mute, mode switch) from a
 * push-to-talk release, where the pending words still deserve a final.
 */
function settleClosedCapture(
  next: VoiceConversationState,
  dropTranscript: boolean,
): VoiceConversationState {
  if (next.status !== "capturing" || isMicOpen(next)) return next;
  return {
    ...next,
    liveTranscript: dropTranscript ? null : next.liveTranscript,
    status: "listening",
  };
}

function beginCapture(state: VoiceConversationState): VoiceTransition {
  const interruption = interruptAssistant(state);
  return {
    effects: interruption.effects,
    state: { ...state, ...interruption.patch, status: "capturing" },
  };
}

function applyVoiceEvent(
  state: VoiceConversationState,
  event: VoiceConversationEvent,
): VoiceTransition {
  switch (event.type) {
    case "session/open": {
      if (state.status !== "idle") return null;
      return {
        effects: [{ type: "start-pipeline" }],
        state: { ...state, error: null, status: "connecting" },
      };
    }

    case "session/ready": {
      if (state.status !== "connecting") return null;
      return { state: { ...state, status: "listening" } };
    }

    case "session/close": {
      if (state.status === "idle") return null;
      const interruption = interruptAssistant(state);
      return {
        effects: interruption.effects,
        state: {
          ...state,
          ...interruption.patch,
          error: null,
          isStreaming: false,
          liveTranscript: null,
          pttHeld: false,
          status: "idle",
        },
        tailEffects: [{ type: "stop-pipeline" }],
      };
    }

    case "input-mode/set": {
      if (event.mode === state.inputMode) return null;
      return {
        effects: [{ mode: event.mode, type: "set-input-mode" }],
        state: settleClosedCapture({ ...state, inputMode: event.mode }, true),
      };
    }

    case "mic/set-muted": {
      if (event.muted === state.micMuted) return null;
      return {
        state: settleClosedCapture({ ...state, micMuted: event.muted }, true),
      };
    }

    case "ptt/press": {
      // Deliberately not gated on `pttHeld`: a repeat press while the key is
      // already down is how a barge-in reaches the reducer mid-reply.
      if (!isSessionActive(state)) return null;
      const capture = beginCapture(state);
      if (capture === null) return null;
      return { ...capture, state: { ...capture.state, pttHeld: true } };
    }

    case "ptt/release": {
      if (!state.pttHeld) return null;
      return {
        state: settleClosedCapture({ ...state, pttHeld: false }, false),
      };
    }

    case "speech/detected": {
      if (!isSessionActive(state) || !isMicOpen(state)) return null;
      return beginCapture(state);
    }

    case "transcript/partial": {
      if (!isSessionActive(state)) return null;
      if (event.text.trim().length === 0) {
        if (state.liveTranscript === null) return null;
        return { state: { ...state, liveTranscript: null } };
      }
      const capture = beginCapture(state);
      if (capture === null) return null;
      return {
        ...capture,
        state: {
          ...capture.state,
          liveTranscript: { isFinal: false, text: event.text },
        },
      };
    }

    case "transcript/final": {
      if (!isSessionActive(state)) return null;
      if (state.turns.some((turn) => turn.id === event.turnId)) return null;
      const text = event.text.trim();
      if (text.length === 0) {
        // Silence, a cough, a false trigger — nothing worth a turn.
        if (state.liveTranscript === null && state.status !== "capturing") {
          return null;
        }
        return {
          state: {
            ...state,
            liveTranscript: null,
            status: state.status === "capturing" ? "listening" : state.status,
          },
        };
      }
      const interruption = interruptAssistant(state);
      const turns = interruption.patch.turns ?? state.turns;
      return {
        effects: [
          ...interruption.effects,
          { text, turnId: event.turnId, type: "submit-utterance" },
        ],
        state: {
          ...state,
          ...interruption.patch,
          liveTranscript: null,
          status: "thinking",
          turns: [
            ...turns,
            {
              id: event.turnId,
              interrupted: false,
              role: "user",
              text,
            },
          ],
        },
      };
    }

    case "assistant/stream-start": {
      if (!isSessionActive(state)) return null;
      return {
        state: {
          ...state,
          activeResponseId: event.responseId,
          assistantDraft: "",
          assistantPlayback: "idle",
          isStreaming: true,
          status: "responding",
        },
      };
    }

    case "assistant/stream-delta": {
      if (state.activeResponseId === null || !state.isStreaming) return null;
      if (event.text.length === 0) return null;
      return {
        state: { ...state, assistantDraft: state.assistantDraft + event.text },
      };
    }

    case "assistant/stream-end": {
      if (state.activeResponseId === null || !state.isStreaming) return null;
      if (state.assistantPlayback !== "idle") {
        // Playback is under way; `playback/ended` closes the turn.
        return { state: { ...state, isStreaming: false } };
      }
      // Text-only reply (TTS off or unavailable) — settle it now rather than
      // waiting for a playback event that will never arrive.
      return { state: commitAssistantTurn(state) };
    }

    case "playback/started": {
      if (state.activeResponseId === null) return null;
      return {
        state: {
          ...state,
          assistantPlayback: "speaking",
          status: "responding",
        },
      };
    }

    case "playback/ended": {
      // A cleared `activeResponseId` means this playback was already barged in
      // on; its ending must not disturb the capture the user started.
      if (state.activeResponseId === null) return null;
      return { state: commitAssistantTurn(state) };
    }

    case "error": {
      // A closed session has nothing to fail and nothing to retry into. The
      // teardown effects of `session/close` can still reject on the way out
      // (the huddle may already be gone); that must not resurrect the surface
      // into an error the user cannot act on.
      if (state.status === "idle") return null;
      const interruption = interruptAssistant(state);
      return {
        effects: interruption.effects,
        state: {
          ...state,
          ...interruption.patch,
          error: event.error,
          isStreaming: false,
          liveTranscript: null,
          pttHeld: false,
          status: "error",
        },
      };
    }

    case "retry": {
      if (state.status !== "error") return null;
      return {
        effects: [{ type: "start-pipeline" }],
        state: { ...state, error: null, status: "connecting" },
      };
    }

    default:
      return null;
  }
}

/** Close out the active reply and return the session to listening. */
function commitAssistantTurn(
  state: VoiceConversationState,
): VoiceConversationState {
  const responseId = state.activeResponseId;
  const spoken = state.assistantDraft.trim();
  const turns =
    responseId !== null && spoken.length > 0
      ? [
          ...state.turns,
          {
            id: assistantTurnId(responseId),
            interrupted: false,
            role: "assistant" as const,
            text: spoken,
          },
        ]
      : state.turns;
  return {
    ...state,
    activeResponseId: null,
    assistantDraft: "",
    assistantPlayback: "idle",
    isStreaming: false,
    status: "listening",
    turns,
  };
}

/**
 * Apply one event. Returns the next state and the effects the host must run,
 * in order. An event that does not apply returns the *same* state object, so
 * callers can rely on reference equality to skip re-renders.
 */
export function reduceVoiceConversation(
  state: VoiceConversationState,
  event: VoiceConversationEvent,
): VoiceConversationResult {
  const transition = applyVoiceEvent(state, event);
  if (transition === null) return { effects: [], state };

  const next = transition.state;
  const effects: VoiceConversationEffect[] = [...(transition.effects ?? [])];
  const wasOpen = isMicOpen(state);
  const nowOpen = isMicOpen(next);
  if (wasOpen !== nowOpen) {
    effects.push({ open: nowOpen, type: "set-mic-open" });
  }
  effects.push(...(transition.tailEffects ?? []));
  return { effects, state: next };
}
