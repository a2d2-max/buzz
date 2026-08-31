import type {
  HuddleVoiceInputMode,
  VoicePipelineBridge,
} from "./voicePipelineRunner.ts";

/** The shape of `invoke` from `@tauri-apps/api/core`, narrowed to what we need. */
export type HuddleInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface HuddleVoiceBridgeOptions {
  /** Stop the agent reply that is currently playing. */
  interruptSpeech: (responseId: number) => Promise<void>;
  invoke: HuddleInvoke;
  /** Hand a finished utterance to whatever already talks to the agent. */
  submitUtterance: (text: string, turnId: string) => Promise<void>;
}

/**
 * Bind the conversation machine to the Huddle audio pipeline that already
 * ships: its transcription gate, its manual-unmute gate, and its input mode.
 *
 * The two host-owned paths — interrupting a playing reply and delivering an
 * utterance to an agent — stay injected. The huddle already owns those
 * transports, and inventing a second one here would duplicate them.
 */
export function createHuddleVoicePipelineBridge({
  interruptSpeech,
  invoke,
  submitUtterance,
}: HuddleVoiceBridgeOptions): VoicePipelineBridge {
  async function setTranscription(enabled: boolean): Promise<void> {
    await invoke("set_huddle_transcription_enabled", { enabled });
  }
  return {
    interruptPlayback: interruptSpeech,
    async setInputMode(mode: HuddleVoiceInputMode) {
      await invoke("set_voice_input_mode", { mode });
    },
    async setMicOpen(open: boolean) {
      await invoke("set_huddle_manual_mic_unmuted", { enabled: open });
    },
    startPipeline: () => setTranscription(true),
    stopPipeline: () => setTranscription(false),
    submitUtterance,
  };
}
