import type {
  VoiceConversationEffect,
  VoiceConversationEvent,
  VoiceErrorCode,
  VoiceInputMode,
} from "./voiceConversationMachine.ts";

/** The mode vocabulary the Huddle Rust backend already speaks. */
export type HuddleVoiceInputMode = "push_to_talk" | "voice_activity";

export function toHuddleVoiceInputMode(
  mode: VoiceInputMode,
): HuddleVoiceInputMode {
  return mode === "hands_free" ? "voice_activity" : "push_to_talk";
}

export function fromHuddleVoiceInputMode(
  mode: HuddleVoiceInputMode,
): VoiceInputMode {
  return mode === "voice_activity" ? "hands_free" : "push_to_talk";
}

/**
 * The seam between the conversation machine and the real audio pipeline.
 *
 * Production wires this to the Huddle Tauri commands; tests inject a recorder.
 * Nothing here reaches a network provider — the implementations live in the
 * host that already owns the microphone, STT, and TTS.
 */
export interface VoicePipelineBridge {
  interruptPlayback: (responseId: number) => Promise<void>;
  setInputMode: (mode: HuddleVoiceInputMode) => Promise<void>;
  setMicOpen: (open: boolean) => Promise<void>;
  startPipeline: () => Promise<void>;
  stopPipeline: () => Promise<void>;
  submitUtterance: (text: string, turnId: string) => Promise<void>;
}

export interface VoicePipelineRunner {
  dispose: () => void;
  run: (effects: readonly VoiceConversationEffect[]) => Promise<void>;
}

/**
 * Which error a failing effect raises. `stop-pipeline` is absent on purpose:
 * teardown is best-effort, and a failed close must never strand the user in an
 * error state they cannot leave.
 */
const EFFECT_ERROR_CODES: Partial<
  Record<VoiceConversationEffect["type"], VoiceErrorCode>
> = {
  "set-input-mode": "pipeline_unavailable",
  "set-mic-open": "mic_unavailable",
  "start-pipeline": "pipeline_unavailable",
  "stop-playback": "tts_failed",
  "submit-utterance": "assistant_failed",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The voice pipeline stopped responding.";
}

/**
 * Interpret effects against the real pipeline, one at a time.
 *
 * Calls are chained onto a single tail promise so separately queued batches
 * still reach the backend in the order the machine produced them — the
 * `stop-playback` before `set-mic-open` ordering that makes barge-in feel
 * instant depends on it.
 */
export function createVoicePipelineRunner(
  bridge: VoicePipelineBridge,
  dispatch: (event: VoiceConversationEvent) => void,
): VoicePipelineRunner {
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  async function apply(effect: VoiceConversationEffect): Promise<void> {
    switch (effect.type) {
      case "start-pipeline":
        await bridge.startPipeline();
        dispatch({ type: "session/ready" });
        return;
      case "stop-pipeline":
        await bridge.stopPipeline();
        return;
      case "set-input-mode":
        await bridge.setInputMode(toHuddleVoiceInputMode(effect.mode));
        return;
      case "set-mic-open":
        await bridge.setMicOpen(effect.open);
        return;
      case "submit-utterance":
        await bridge.submitUtterance(effect.text, effect.turnId);
        return;
      case "stop-playback":
        await bridge.interruptPlayback(effect.responseId);
        return;
    }
  }

  async function runBatch(
    effects: readonly VoiceConversationEffect[],
  ): Promise<void> {
    for (const effect of effects) {
      if (disposed) return;
      try {
        await apply(effect);
      } catch (error) {
        const code = EFFECT_ERROR_CODES[effect.type];
        if (code === undefined) {
          console.warn("[voice-chat] teardown effect failed:", error);
          continue;
        }
        if (!disposed) {
          dispatch({
            error: { code, message: errorMessage(error) },
            type: "error",
          });
        }
        return;
      }
    }
  }

  return {
    dispose() {
      disposed = true;
    },
    run(effects) {
      if (effects.length === 0) return Promise.resolve();
      // Swallow at the join so one unexpected rejection cannot poison the
      // chain and silently stall every later batch.
      tail = tail
        .then(() => runBatch(effects))
        .catch((error) => {
          console.error("[voice-chat] effect queue failed:", error);
        });
      return tail;
    },
  };
}
