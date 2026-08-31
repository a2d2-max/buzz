import {
  classifySpeakableAgentText,
  type LiveTtsEvent,
} from "@/features/huddle/lib/ttsLiveMessages";
import type { VoiceConversationEvent } from "./voiceConversationMachine.ts";

export interface HuddleVoiceSourceOptions {
  agentPubkeys: ReadonlySet<string>;
  channelId: string;
  selfPubkey: string | null;
}

export interface HuddleVoiceSource {
  handle: (event: LiveTtsEvent) => VoiceConversationEvent[];
  setAgentPubkeys: (pubkeys: ReadonlySet<string>) => void;
  /** Which agent owns a response — the pubkey `interrupt_huddle_speech` needs. */
  speakerFor: (responseId: number) => string | null;
}

/** Bound so a long huddle cannot grow the dedup set without limit. */
const MAX_SEEN_EVENTS = 2_000;
/** Only a recent reply can still be playing and therefore be interruptible. */
const MAX_TRACKED_SPEAKERS = 64;

/**
 * Turn the huddle's live message stream into conversation events.
 *
 * The huddle already carries both halves of a voice turn as Nostr messages on
 * the ephemeral channel: the Rust STT publishes what the user said, and the
 * agent's reply comes back the same way. Mapping them here reuses that
 * pipeline instead of opening a second transport.
 *
 * Agent replies arrive whole, so each becomes a start/delta/end triple. Token
 * streaming and playback boundaries are not observable from the desktop today;
 * the machine already accepts those events for when a backend signal exists.
 */
export function createHuddleVoiceSource({
  agentPubkeys,
  channelId,
  selfPubkey,
}: HuddleVoiceSourceOptions): HuddleVoiceSource {
  let agents = agentPubkeys;
  let nextResponseId = 1;
  const speakers = new Map<number, string>();
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  function alreadyHandled(eventId: string): boolean {
    if (seen.has(eventId)) return true;
    seen.add(eventId);
    seenOrder.push(eventId);
    if (seenOrder.length > MAX_SEEN_EVENTS) {
      const oldest = seenOrder.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }

  return {
    handle(event) {
      if (alreadyHandled(event.id)) return [];

      // The agent classifier owns kind, channel, and system-text screening, so
      // both branches inherit the same gate. It checks agent membership before
      // authorship, though, so my own message lands on `author_not_agent` —
      // read the identity here rather than trusting that label.
      const eligibility = classifySpeakableAgentText(
        event,
        agents,
        selfPubkey,
        channelId,
      );
      if (
        eligibility.reason === "unsupported_kind" ||
        eligibility.reason === "h_tag_mismatch"
      ) {
        return [];
      }

      if (selfPubkey !== null && event.pubkey === selfPubkey) {
        const text = event.content.trim();
        if (text.length === 0) return [];
        return [{ text, turnId: event.id, type: "transcript/final" }];
      }

      if (eligibility.text === null) return [];

      const responseId = nextResponseId;
      nextResponseId += 1;
      speakers.set(responseId, event.pubkey);
      // Only a recent response can still be playing, so the older entries are
      // dead weight in a long huddle.
      if (speakers.size > MAX_TRACKED_SPEAKERS) {
        speakers.delete(responseId - MAX_TRACKED_SPEAKERS);
      }
      return [
        { responseId, type: "assistant/stream-start" },
        { text: eligibility.text, type: "assistant/stream-delta" },
        { type: "assistant/stream-end" },
      ];
    },
    setAgentPubkeys(pubkeys) {
      agents = pubkeys;
    },
    speakerFor(responseId) {
      return speakers.get(responseId) ?? null;
    },
  };
}
