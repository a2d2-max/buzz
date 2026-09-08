// kind:39000(NIP-29 그룹 메타데이터) → 채널 목록 항목.
// 이벤트 모양의 원본은 crates/buzz-relay/src/handlers/side_effects.rs 의
// emit_group_discovery_events — 태그로 name/about/t(종류)/hidden/archived 를 싣는다.

import type { NostrEvent } from "../../shared/lib/relay.ts";
import { KIND_NIP29_GROUP_METADATA } from "../../shared/lib/kinds.ts";

export type Channel = {
  /** 채널 id (d 태그, UUID). */
  id: string;
  name: string;
  about: string | null;
  /** stream | forum | dm 등. 알 수 없으면 "stream" 으로 본다. */
  channelType: string;
  hidden: boolean;
  archived: boolean;
  /** 같은 채널의 여러 판 중 최신을 고르기 위한 relay created_at. */
  eventCreatedAt: number;
};

function firstTagValue(event: NostrEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

function hasTag(event: NostrEvent, name: string): boolean {
  return event.tags.some((tag) => tag[0] === name);
}

export function parseChannelEvent(event: NostrEvent): Channel | null {
  if (event.kind !== KIND_NIP29_GROUP_METADATA) return null;
  const id = firstTagValue(event, "d");
  if (!id) return null;
  const name = firstTagValue(event, "name");
  if (!name) return null;
  return {
    id,
    name,
    about: firstTagValue(event, "about"),
    channelType: firstTagValue(event, "t") ?? "stream",
    hidden: hasTag(event, "hidden"),
    archived: firstTagValue(event, "archived") === "true",
    eventCreatedAt: event.created_at,
  };
}

/**
 * 이벤트 뭉치 → 보여줄 채널 목록.
 * 같은 id 는 최신 판만 남기고, 숨김(DM)·보관 채널은 빼고, 이름순 정렬.
 */
export function buildChannelList(events: NostrEvent[]): Channel[] {
  const latest = new Map<string, Channel>();
  for (const event of events) {
    const channel = parseChannelEvent(event);
    if (!channel) continue;
    const current = latest.get(channel.id);
    if (!current || channel.eventCreatedAt > current.eventCreatedAt) {
      latest.set(channel.id, channel);
    }
  }
  return [...latest.values()]
    .filter((channel) => !channel.hidden && !channel.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
}
