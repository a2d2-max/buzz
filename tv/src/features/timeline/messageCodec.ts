// 채널 타임라인 메시지(kind 9 · 40002)와 작성자 프로필(kind 0) 해석.
// content 는 마크다운 원문이고, 채널 소속은 #h 태그다(NIP-29).

import type { NostrEvent } from "../../shared/lib/relay.ts";
import {
  KIND_PROFILE,
  TIMELINE_MESSAGE_KINDS,
} from "../../shared/lib/kinds.ts";

export type TimelineMessage = {
  id: string;
  pubkey: string;
  /** 마크다운 원문. */
  content: string;
  createdAt: number;
  /** 스레드 루트에 달린 답글이면 그 루트 이벤트 id (e 태그). */
  replyTo: string | null;
};

export function parseTimelineMessage(
  event: NostrEvent,
): TimelineMessage | null {
  if (!TIMELINE_MESSAGE_KINDS.includes(event.kind)) return null;
  if (typeof event.content !== "string" || event.content.length === 0) {
    return null;
  }
  let replyTo: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] === "e" && typeof tag[1] === "string") {
      replyTo = tag[1];
      break;
    }
  }
  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    replyTo,
  };
}

/** 새 이벤트를 목록에 끼워 넣는다. 중복(id)은 버리고 시간순을 지킨다. */
export function insertMessage(
  messages: TimelineMessage[],
  incoming: TimelineMessage,
): TimelineMessage[] {
  if (messages.some((message) => message.id === incoming.id)) return messages;
  const next = [...messages, incoming];
  next.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return next;
}

export type Profile = {
  pubkey: string;
  displayName: string;
};

/** kind:0 프로필 content(JSON)에서 표시 이름을 뽑는다. */
export function parseProfileEvent(event: NostrEvent): Profile | null {
  if (event.kind !== KIND_PROFILE) return null;
  try {
    const raw = JSON.parse(event.content) as Record<string, unknown>;
    const displayName =
      pickString(raw.display_name) ??
      pickString(raw.displayName) ??
      pickString(raw.name);
    if (!displayName) return null;
    return { pubkey: event.pubkey, displayName };
  } catch {
    return null;
  }
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** 프로필이 없을 때 쓰는 축약 표기. 8자리면 화면에서 구분엔 충분하다. */
export function shortPubkey(pubkey: string): string {
  return pubkey.slice(0, 8);
}
