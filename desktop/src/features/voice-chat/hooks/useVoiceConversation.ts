import * as React from "react";

import {
  createVoiceConversationState,
  reduceVoiceConversation,
  isSessionActive,
  type VoiceConversationEvent,
  type VoiceConversationState,
  type VoiceInputMode,
} from "../lib/voiceConversationMachine.ts";
import {
  createVoicePipelineRunner,
  type VoicePipelineBridge,
} from "../lib/voicePipelineRunner.ts";
import {
  describeVoiceConversation,
  type VoiceConversationView,
} from "../lib/voiceConversationView.ts";

export type VoiceDispatch = (event: VoiceConversationEvent) => void;

export interface UseVoiceConversationOptions {
  /** Where effects are executed. Recreated freely — it is held behind a ref. */
  bridge: VoicePipelineBridge;
  /**
   * Attach the host's own event sources (transcripts, assistant stream,
   * playback, the huddle `ptt-state` event) and return a teardown.
   * Memoize it with `useCallback`; it is an effect dependency.
   */
  subscribe?: (dispatch: VoiceDispatch) => (() => void) | undefined;
}

export interface UseVoiceConversationResult {
  close: () => void;
  dispatch: VoiceDispatch;
  open: () => void;
  pressPtt: () => void;
  releasePtt: () => void;
  retry: () => void;
  setInputMode: (mode: VoiceInputMode) => void;
  setMuted: (muted: boolean) => void;
  state: VoiceConversationState;
  view: VoiceConversationView;
}

/**
 * Bind the pure conversation machine to React and the audio pipeline.
 *
 * Everything worth testing lives in `../lib`; this hook only owns wiring —
 * which is why it keeps no derived state of its own. Dispatch is synchronous
 * so a barge-in reaches `stop-playback` in the same tick the key goes down.
 */
export function useVoiceConversation({
  bridge,
  subscribe,
}: UseVoiceConversationOptions): UseVoiceConversationResult {
  const [state, setState] = React.useState(createVoiceConversationState);
  const stateRef = React.useRef(state);
  const runnerRef = React.useRef<ReturnType<
    typeof createVoicePipelineRunner
  > | null>(null);

  const bridgeRef = React.useRef(bridge);
  bridgeRef.current = bridge;
  // A stable façade so a host that rebuilds its bridge every render does not
  // tear down and rebuild the runner (and its ordering queue) with it.
  const stableBridge = React.useMemo<VoicePipelineBridge>(
    () => ({
      interruptPlayback: (responseId) =>
        bridgeRef.current.interruptPlayback(responseId),
      setInputMode: (mode) => bridgeRef.current.setInputMode(mode),
      setMicOpen: (open) => bridgeRef.current.setMicOpen(open),
      startPipeline: () => bridgeRef.current.startPipeline(),
      stopPipeline: () => bridgeRef.current.stopPipeline(),
      submitUtterance: (text, turnId) =>
        bridgeRef.current.submitUtterance(text, turnId),
    }),
    [],
  );

  const dispatch = React.useCallback<VoiceDispatch>((event) => {
    const result = reduceVoiceConversation(stateRef.current, event);
    if (result.state !== stateRef.current) {
      stateRef.current = result.state;
      setState(result.state);
    }
    if (result.effects.length > 0) {
      void runnerRef.current?.run(result.effects);
    }
  }, []);

  React.useEffect(() => {
    const runner = createVoicePipelineRunner(stableBridge, dispatch);
    runnerRef.current = runner;
    return () => {
      const wasActive = isSessionActive(stateRef.current);
      runner.dispose();
      runnerRef.current = null;
      if (!wasActive) return;
      // The component is going away mid-session: close the microphone and the
      // pipeline directly, since the disposed runner will not.
      void stableBridge.setMicOpen(false).catch(() => {});
      void stableBridge.stopPipeline().catch(() => {});
    };
  }, [dispatch, stableBridge]);

  React.useEffect(() => {
    if (!subscribe) return;
    return subscribe(dispatch);
  }, [dispatch, subscribe]);

  const view = React.useMemo(() => describeVoiceConversation(state), [state]);

  const close = React.useCallback(
    () => dispatch({ type: "session/close" }),
    [dispatch],
  );
  const open = React.useCallback(
    () => dispatch({ type: "session/open" }),
    [dispatch],
  );
  const pressPtt = React.useCallback(
    () => dispatch({ type: "ptt/press" }),
    [dispatch],
  );
  const releasePtt = React.useCallback(
    () => dispatch({ type: "ptt/release" }),
    [dispatch],
  );
  const retry = React.useCallback(
    () => dispatch({ type: "retry" }),
    [dispatch],
  );
  const setInputMode = React.useCallback(
    (mode: VoiceInputMode) => dispatch({ mode, type: "input-mode/set" }),
    [dispatch],
  );
  const setMuted = React.useCallback(
    (muted: boolean) => dispatch({ muted, type: "mic/set-muted" }),
    [dispatch],
  );

  return {
    close,
    dispatch,
    open,
    pressPtt,
    releasePtt,
    retry,
    setInputMode,
    setMuted,
    state,
    view,
  };
}
