# RAOU voice chat

A ChatGPT-style realtime voice conversation, riding the audio session the
huddle already owns. There is no second microphone stack, no second STT or TTS
path, and no identity or key entry — the surface appears once a huddle is
running and reuses its pipeline.

## Shape

```
  huddle audio session
        │
        ├── ptt-state (Tauri)  ────────┐
        ├── live channel messages ─────┤
        │     (kind 9 / 40002)         │
        │                              ▼
        │                    huddleVoiceSource ── conversation events
        │                                              │
        │                                              ▼
        │                                  voiceConversationMachine
        │                                    (pure: state + effects)
        │                                              │
        └───── Tauri commands ◄── voicePipelineRunner ─┘
                                          ▲
                                  huddleVoiceBridge
```

| Module | Role |
|---|---|
| `lib/voiceConversationMachine.ts` | The whole lifecycle as a pure reducer: `(state, event) → {state, effects}`. Owns push-to-talk vs hands-free, live transcript states, assistant streaming, playback, barge-in, mute, error/retry. |
| `lib/voicePipelineRunner.ts` | Executes effects against an injected `VoicePipelineBridge`, one at a time, in order. Turns a failing call into a retryable error event. |
| `lib/huddleVoiceBridge.ts` | The production bridge, built only from Huddle commands that already ship. |
| `lib/huddleVoiceSource.ts` | Maps the huddle's live message stream onto conversation events. |
| `lib/voiceConversationView.ts` | Everything the UI renders — labels, live-region politeness, mic button state, transcript entries. |
| `hooks/useVoiceConversation.ts` | Binds the reducer to React and the runner. No logic of its own. |
| `hooks/useHuddleVoiceChat.ts` | Wires the bridge and the source to the running huddle. |
| `components/` | `RaouVoiceDock` (entry point above the huddle bar) → `VoiceConversationPanel` → `VoiceTranscript`. |

Logic lives in `lib/`, which is why the whole conversation is covered by
`node:test` with no DOM, no Tauri mock, and no hardware.

```bash
cd desktop
node --import ./test-loader.mjs --experimental-strip-types \
  --test "src/features/voice-chat/**/*.test.mjs"
```

## Why the machine returns effects instead of calling anything

Barge-in has to reach `stop-playback` before the microphone reopens, and a
cancelled reply must not have its late tokens land in the next turn. Both are
ordering properties. Describing them as data (`{type: "stop-playback",
responseId}`) makes them assertable; calling `invoke()` inline would not.

`activeResponseId` doubles as a generation counter — a barge-in clears it, so
deltas from the cancelled response are dropped rather than appended. This is
the same idea as `createLatestStateGate` on the huddle TTS path.

## Microphone openness is derived, never stored

`isMicOpen()` reads from the input mode, the manual mute, and the push-to-talk
key. It mirrors the huddle's own rule — a held push-to-talk key temporarily
opens a manually muted microphone, and hands-free never overrides that mute.
Storing a boolean would let it drift from the inputs that decide it.

## What is wired, and what still needs a backend signal

Live today, on existing commands and events:

- push-to-talk (`ptt-state`), hands-free, and the manual mute
- the microphone gate (`set_huddle_manual_mic_unmuted`)
- the input mode (`set_voice_input_mode`, mapped to `voice_activity`)
- the transcription pipeline (`set_huddle_transcription_enabled`)
- barge-in (`interrupt_huddle_speech`, resolved through `speakerFor`)
- final user transcripts and whole agent replies, off the live channel stream

Not observable from the desktop yet — the machine already accepts these events,
so wiring them is the only step left:

- **Partial transcripts.** Nothing emits them; STT publishes finished
  utterances as channel messages. `transcript/partial` and `speech/detected`
  need a Rust-side event before the live "hearing you" text can stream.
- **Token-level assistant streaming.** Replies arrive whole, so each becomes a
  single start/delta/end triple.
- **Playback boundaries.** `speak_agent_message` does not report when audio
  starts or ends, so a reply settles at `assistant/stream-end`. Once
  `playback/started` and `playback/ended` exist, the machine holds the turn
  open for the duration of the speech with no change here.

`submitUtterance` is a no-op in the huddle bridge on purpose: the transcription
pipeline already published the utterance that produced the final transcript,
and sending it again would post the user's words twice. It becomes a real
publish the day a transcript arrives from an event instead of a message.
