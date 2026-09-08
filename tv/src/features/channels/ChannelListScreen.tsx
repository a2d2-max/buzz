// 채널 목록 화면 (루트). 위쪽에 Docs·설정으로 가는 버튼을 둔다.
// kind:39000 은 채널 범위로 저장돼 실시간 fan-out 이 안 오므로
// (릴레이 side_effects.rs 주석 참조) 1회 조회로 충분하다.

import { useEffect, useState } from "react";
import type { RelayConnection } from "../../shared/lib/relay.ts";
import { KIND_NIP29_GROUP_METADATA } from "../../shared/lib/kinds.ts";
import { FocusItem } from "../../shared/ui/FocusItem.tsx";
import { buildChannelList, type Channel } from "./channelCodec.ts";

type ChannelListScreenProps = {
  relay: RelayConnection;
  onOpenChannel: (channel: Channel) => void;
  onOpenDocs: () => void;
  onOpenSettings: () => void;
};

export function ChannelListScreen({
  relay,
  onOpenChannel,
  onOpenDocs,
  onOpenSettings,
}: ChannelListScreenProps) {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    relay
      .queryOnce({ kinds: [KIND_NIP29_GROUP_METADATA], limit: 500 })
      .then((events) => {
        if (alive) setChannels(buildChannelList(events));
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      alive = false;
    };
  }, [relay]);

  return (
    <div className="screen" data-testid="channel-list-screen">
      <h1 className="screen-title">채널</h1>
      <div className="dialog-buttons">
        <FocusItem onSelect={onOpenDocs}>
          <span className="item-title">📚 Docs</span>
        </FocusItem>
        <FocusItem onSelect={onOpenSettings}>
          <span className="item-title">⚙️ 설정</span>
        </FocusItem>
      </div>
      {error ? (
        <p className="status-line error">채널을 못 불러왔습니다: {error}</p>
      ) : null}
      {channels === null && !error ? (
        <p className="status-line">불러오는 중…</p>
      ) : null}
      {channels !== null && channels.length === 0 ? (
        <p className="status-line">
          보이는 채널이 없습니다. 이 키가 볼 수 있는 채널이 없을 수 있습니다.
        </p>
      ) : null}
      <div className="scroll-list">
        {channels?.map((channel, index) => (
          <FocusItem
            key={channel.id}
            onSelect={() => onOpenChannel(channel)}
            autoFocus={index === 0}
          >
            <span className="item-title"># {channel.name}</span>
            {channel.about ? (
              <span className="item-sub">{channel.about}</span>
            ) : null}
          </FocusItem>
        ))}
      </div>
    </div>
  );
}
