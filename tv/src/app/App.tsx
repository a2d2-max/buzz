// 앱 셸: 설정 확보 → 릴레이 연결 → 화면 스택.
// - 뒤로가기(461, 개발용 Escape): 스택을 하나 걷고, 루트면 종료 확인을 띄운다.
//   appinfo.json 의 disableBackHistoryAPI=true 와 짝이다.
// - localStorage 는 캐시 취급: 설정이 없거나 인증이 깨지면 설정 화면으로 돌아간다.

import { useCallback, useEffect, useState } from "react";
import { isBackKey } from "../remote/keys.ts";
import { usePointerState } from "../remote/usePointerState.ts";
import { RelayConnection, type RelayStatus } from "../shared/lib/relay.ts";
import {
  buildSettings,
  clearSettings,
  loadSettings,
  readLaunchParams,
  saveSettings,
  stripLaunchParams,
  type TvSettings,
} from "../shared/lib/settings.ts";
import { FocusItem } from "../shared/ui/FocusItem.tsx";
import type { Channel } from "../features/channels/channelCodec.ts";
import { ChannelListScreen } from "../features/channels/ChannelListScreen.tsx";
import type { DocListEntry } from "../features/docs/docCodec.ts";
import { DocsListScreen } from "../features/docs/DocsListScreen.tsx";
import { DocViewerScreen } from "../features/docs/DocViewerScreen.tsx";
import { SettingsScreen } from "../features/settings/SettingsScreen.tsx";
import { TimelineScreen } from "../features/timeline/TimelineScreen.tsx";

type Screen =
  | { kind: "channels" }
  | { kind: "timeline"; channel: Channel }
  | { kind: "docs" }
  | { kind: "docViewer"; doc: DocListEntry };

/** URL 주입 → 저장된 설정 순서로 초기 설정을 정한다. */
function resolveInitialSettings(): TvSettings | null {
  const params = readLaunchParams(window.location);
  if (params.relay && params.key) {
    const result = buildSettings(params.relay, params.key);
    stripLaunchParams();
    if (result.ok) {
      saveSettings(result.settings);
      return result.settings;
    }
    return null;
  }
  if (params.relay || params.key) stripLaunchParams();
  return loadSettings();
}

function ExitConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="overlay" data-testid="exit-dialog">
      <div className="dialog">
        <p style={{ margin: 0, fontSize: "32px" }}>a2d2 TV 를 종료할까요?</p>
        <div className="dialog-buttons">
          <FocusItem onSelect={onCancel} autoFocus>
            <span className="item-title">계속 보기</span>
          </FocusItem>
          <FocusItem onSelect={onConfirm}>
            <span className="item-title">종료</span>
          </FocusItem>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<TvSettings | null>(() =>
    resolveInitialSettings(),
  );
  const [settingsNotice, setSettingsNotice] = useState<string | undefined>();
  const [stack, setStack] = useState<Screen[]>([{ kind: "channels" }]);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>("connecting");
  usePointerState();

  // 연결 생성은 effect 에서 — StrictMode 의 이중 호출에도 연결이 새지 않게
  // 만든 곳에서 정리(dispose)까지 책임진다.
  const [relay, setRelay] = useState<RelayConnection | null>(null);
  useEffect(() => {
    if (!settings) {
      setRelay(null);
      return;
    }
    const connection = new RelayConnection(
      settings.relayUrl,
      settings.secretKeyHex,
    );
    connection.onStatusChange = setRelayStatus;
    setRelayStatus(connection.status);
    setRelay(connection);
    return () => {
      connection.onStatusChange = null;
      connection.dispose();
      setRelay(null);
    };
  }, [settings]);

  // 인증 실패 = 키가 릴레이에서 거부됨. 캐시(저장 키)를 비우고 설정으로.
  useEffect(() => {
    if (relayStatus === "auth-failed") {
      clearSettings();
      setSettings(null);
      setSettingsNotice(
        "릴레이가 이 키를 거부했습니다. 키를 다시 등록해 주세요.",
      );
      setStack([{ kind: "channels" }]);
    }
  }, [relayStatus]);

  const push = useCallback((screen: Screen) => {
    setStack((current) => [...current, screen]);
  }, []);

  const handleBack = useCallback(() => {
    if (exitConfirm) {
      setExitConfirm(false);
      return;
    }
    setStack((current) => {
      if (current.length > 1) return current.slice(0, -1);
      setExitConfirm(true);
      return current;
    });
  }, [exitConfirm]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isBackKey(event)) return;
      event.preventDefault();
      handleBack();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleBack]);

  if (settings && !relay) {
    // 연결 객체가 만들어지는 한 프레임 사이.
    return <p className="status-line screen">연결 준비 중…</p>;
  }

  if (!settings || !relay) {
    return (
      <>
        <SettingsScreen
          notice={settingsNotice}
          initialRelayUrl={settings?.relayUrl}
          onComplete={(next) => {
            setSettingsNotice(undefined);
            setStack([{ kind: "channels" }]);
            setSettings(next);
          }}
        />
        {exitConfirm ? (
          <ExitConfirmDialog
            onConfirm={() => window.close()}
            onCancel={() => setExitConfirm(false)}
          />
        ) : null}
      </>
    );
  }

  const top = stack[stack.length - 1];

  return (
    <>
      {top.kind === "channels" ? (
        <ChannelListScreen
          relay={relay}
          onOpenChannel={(channel) => push({ kind: "timeline", channel })}
          onOpenDocs={() => push({ kind: "docs" })}
          onOpenSettings={() => {
            // 설정 화면으로 가는 명시적 길: 저장 키를 지우진 않는다.
            setSettings(null);
            setSettingsNotice(undefined);
          }}
        />
      ) : null}
      {top.kind === "timeline" ? (
        <TimelineScreen relay={relay} channel={top.channel} />
      ) : null}
      {top.kind === "docs" ? (
        <DocsListScreen
          relay={relay}
          onOpenDoc={(doc) => push({ kind: "docViewer", doc })}
        />
      ) : null}
      {top.kind === "docViewer" ? <DocViewerScreen doc={top.doc} /> : null}
      {relayStatus === "reconnecting" ? (
        <p
          className="status-line"
          style={{ position: "fixed", bottom: 12, right: 24 }}
        >
          다시 연결하는 중…
        </p>
      ) : null}
      {exitConfirm ? (
        <ExitConfirmDialog
          onConfirm={() => window.close()}
          onCancel={() => setExitConfirm(false)}
        />
      ) : null}
    </>
  );
}
