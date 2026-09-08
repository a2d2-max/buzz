// 채널 타임라인. 구독 하나(kind 9·40002, #h=채널)로 과거분과 실시간을
// 같이 받는다 — REQ 를 EOSE 뒤에도 열어 두므로 사이 틈이 없다.
// 작성자 이름은 kind:0 프로필을 뒤따라 조회해 채운다.

import { useEffect, useRef, useState } from "react";
import type { RelayConnection } from "../../shared/lib/relay.ts";
import {
  KIND_PROFILE,
  TIMELINE_MESSAGE_KINDS,
} from "../../shared/lib/kinds.ts";
import { setFocus } from "../../remote/spatial.ts";
import { FocusItem } from "../../shared/ui/FocusItem.tsx";
import { Markdown } from "../../shared/ui/Markdown.tsx";
import type { Channel } from "../channels/channelCodec.ts";
import {
  insertMessage,
  parseProfileEvent,
  parseTimelineMessage,
  shortPubkey,
  type TimelineMessage,
} from "./messageCodec.ts";

const HISTORY_LIMIT = 100;

function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TimelineScreen({
  relay,
  channel,
}: {
  relay: RelayConnection;
  channel: Channel;
}) {
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이미 프로필을 요청한 pubkey — 중복 조회 방지. */
  const requestedProfiles = useRef(new Set<string>());
  /** 첫 포커스를 줬는지. */
  const didInitialFocus = useRef(false);

  useEffect(() => {
    setMessages([]);
    setLoaded(false);
    setError(null);
    requestedProfiles.current = new Set();
    didInitialFocus.current = false;

    const unsubscribe = relay.subscribe(
      {
        kinds: [...TIMELINE_MESSAGE_KINDS],
        "#h": [channel.id],
        limit: HISTORY_LIMIT,
      },
      {
        onEvent: (event) => {
          const message = parseTimelineMessage(event);
          if (message) {
            setMessages((current) => insertMessage(current, message));
          }
        },
        onEose: () => setLoaded(true),
        onClosed: (reason) => setError(reason),
      },
    );
    return unsubscribe;
  }, [relay, channel.id]);

  // 과거분이 다 오면(EOSE) 마지막 행에 포커스를 준다. 렌더 배칭 때문에
  // 행 마운트 시점의 autoFocus 로는 못 잡는다 — 이벤트 여러 개와 EOSE 가
  // 한 렌더로 묶이면 어떤 행도 "마지막" 상태로 마운트되지 않아 화면이
  // 포커스 없는 채로 남았다(5-way 규칙 위반). setFocus 로 명시한다.
  useEffect(() => {
    if (loaded && !didInitialFocus.current && messages.length > 0) {
      didInitialFocus.current = true;
      setFocus(`msg-${messages[messages.length - 1].id}`);
    }
  }, [loaded, messages]);

  // 화면에 있는 작성자 중 이름을 아직 안 물어본 pubkey 를 모아 한 번에 조회.
  useEffect(() => {
    const missing = [
      ...new Set(messages.map((message) => message.pubkey)),
    ].filter((pubkey) => !requestedProfiles.current.has(pubkey));
    if (missing.length === 0) return;
    for (const pubkey of missing) requestedProfiles.current.add(pubkey);
    relay
      .queryOnce({ kinds: [KIND_PROFILE], authors: missing })
      .then((events) => {
        setNames((current) => {
          const next = new Map(current);
          for (const event of events) {
            const profile = parseProfileEvent(event);
            if (profile) next.set(profile.pubkey, profile.displayName);
          }
          return next;
        });
      })
      .catch(() => {
        // 이름 조회 실패는 치명적이지 않다 — 축약 pubkey 로 보여 준다.
      });
  }, [messages, relay]);

  return (
    <div className="screen" data-testid="timeline-screen">
      <h1 className="screen-title"># {channel.name}</h1>
      {channel.about ? (
        <p className="screen-subtitle">{channel.about}</p>
      ) : null}
      {error ? (
        <p className="status-line error">타임라인을 못 불러왔습니다: {error}</p>
      ) : null}
      {!loaded && !error ? <p className="status-line">불러오는 중…</p> : null}
      {loaded && messages.length === 0 ? (
        <p className="status-line">아직 메시지가 없습니다.</p>
      ) : null}
      <div className="scroll-list" data-testid="timeline-list">
        {messages.map((message) => (
          <FocusItem
            key={message.id}
            focusKey={`msg-${message.id}`}
            onSelect={() => {
              // 읽기 전용 — OK 에 할 일이 없지만, 포커스 이동(스크롤)을
              // 위해 행 자체는 선택 가능해야 한다.
            }}
            className="message-row"
          >
            <div className="message-meta">
              <span className="message-author">
                {names.get(message.pubkey) ?? shortPubkey(message.pubkey)}
              </span>
              <span className="message-time">
                {formatTime(message.createdAt)}
              </span>
            </div>
            <Markdown source={message.content} />
          </FocusItem>
        ))}
      </div>
    </div>
  );
}
