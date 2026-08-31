import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";

import { useHuddle } from "@/features/huddle";
import { buildHuddleTtsLiveFilter } from "@/shared/api/relayChannelFilters";
import { relayClient } from "@/shared/api/relayClient";
import { createHuddleVoicePipelineBridge } from "../lib/huddleVoiceBridge.ts";
import {
  createHuddleVoiceSource,
  type HuddleVoiceSource,
} from "../lib/huddleVoiceSource.ts";
import type { VoicePipelineBridge } from "../lib/voicePipelineRunner.ts";
import {
  useVoiceConversation,
  type UseVoiceConversationResult,
  type VoiceDispatch,
} from "./useVoiceConversation.ts";

/** Matches the huddle TTS path — recovers a reply stored moments before we attach. */
const STARTUP_REPLAY_WINDOW_SECONDS = 5;
const AGENT_REFRESH_INTERVAL_MS = 30_000;

export interface UseHuddleVoiceChatOptions {
  /**
   * Attach to the huddle's live stream and push-to-talk events only while the
   * voice surface is actually in use. A huddle participant who never opens
   * voice chat should not carry an extra relay subscription.
   */
  enabled?: boolean;
}

export interface UseHuddleVoiceChatResult extends UseVoiceConversationResult {
  /** False until a huddle is running — voice chat needs its audio session. */
  available: boolean;
}

/**
 * Wire the RAOU voice conversation to the huddle that is already running.
 *
 * Nothing new is opened: the microphone, STT, and TTS all belong to the huddle
 * audio session, and both halves of a turn ride its existing live message
 * stream. This hook only translates between the two.
 */
export function useHuddleVoiceChat({
  enabled = true,
}: UseHuddleVoiceChatOptions = {}): UseHuddleVoiceChatResult {
  const { activeEphemeralChannelId, interruptAgentSpeech } = useHuddle();
  const sourceRef = React.useRef<HuddleVoiceSource | null>(null);

  const bridge = React.useMemo<VoicePipelineBridge>(
    () =>
      createHuddleVoicePipelineBridge({
        interruptSpeech: async (responseId) => {
          const speaker = sourceRef.current?.speakerFor(responseId) ?? null;
          if (speaker === null) return;
          await interruptAgentSpeech(speaker);
        },
        invoke,
        // The huddle's own transcription already published this utterance to
        // the channel — that publish is what produced the final transcript.
        // Sending it again would post the user's words twice.
        submitUtterance: async () => {},
      }),
    [interruptAgentSpeech],
  );

  const subscribe = React.useCallback(
    (dispatch: VoiceDispatch) => {
      const channelId = activeEphemeralChannelId;
      if (channelId === null || !enabled) return;

      let disposed = false;
      let unlistenPtt: (() => void) | null = null;
      let disposeRelay: (() => void) | null = null;
      let agentRefreshId: number | null = null;

      void listen<boolean>("ptt-state", (event) => {
        if (disposed) return;
        dispatch({ type: event.payload ? "ptt/press" : "ptt/release" });
      })
        .then((cleanup) => {
          if (disposed) cleanup();
          else unlistenPtt = cleanup;
        })
        .catch((error) => {
          console.warn("[voice-chat] push-to-talk events unavailable:", error);
        });

      async function attach(channel: string) {
        // Resolve identity and membership before attaching. Anything that
        // cannot be attributed is dropped, so subscribing early would silently
        // discard the first turn instead of replaying it.
        const [identity, agentPubkeys] = await Promise.all([
          invoke<{ pubkey: string }>("get_identity"),
          invoke<string[]>("get_huddle_agent_pubkeys"),
        ]);
        if (disposed) return;

        const source = createHuddleVoiceSource({
          agentPubkeys: new Set(agentPubkeys),
          channelId: channel,
          selfPubkey: identity.pubkey,
        });
        sourceRef.current = source;

        agentRefreshId = window.setInterval(() => {
          void invoke<string[]>("get_huddle_agent_pubkeys")
            .then((pubkeys) => {
              if (!disposed) source.setAgentPubkeys(new Set(pubkeys));
            })
            .catch(() => {
              // Fail closed: an unknown roster speaks for nobody.
              if (!disposed) source.setAgentPubkeys(new Set());
            });
        }, AGENT_REFRESH_INTERVAL_MS);

        const since =
          Math.floor(Date.now() / 1000) - STARTUP_REPLAY_WINDOW_SECONDS;
        const dispose = await relayClient.subscribeLive(
          buildHuddleTtsLiveFilter(channel, since),
          (event) => {
            if (disposed) return;
            for (const voiceEvent of source.handle(event)) {
              dispatch(voiceEvent);
            }
          },
        );
        if (disposed) {
          void dispose();
          return;
        }
        disposeRelay = () => void dispose();
      }

      void attach(channelId).catch((error) => {
        if (disposed) return;
        dispatch({
          error: {
            code: "pipeline_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Couldn’t attach to the huddle transcript.",
          },
          type: "error",
        });
      });

      return () => {
        disposed = true;
        unlistenPtt?.();
        disposeRelay?.();
        if (agentRefreshId !== null) window.clearInterval(agentRefreshId);
        sourceRef.current = null;
      };
    },
    [activeEphemeralChannelId, enabled],
  );

  const conversation = useVoiceConversation({ bridge, subscribe });
  return { ...conversation, available: activeEphemeralChannelId !== null };
}
