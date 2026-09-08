// 설정 화면: 릴레이 URL + 세션 전용 관전 키.
// 입력칸에 OK 를 누르면 spatial nav 를 멈추고 DOM 포커스를 넘겨
// webOS 가상 키보드가 뜨게 한다. 입력을 마치면(Enter/뒤로) 다시 켠다.

import { useEffect, useRef, useState } from "react";
import { buildSettings, type TvSettings } from "../../shared/lib/settings.ts";
import { FocusItem } from "../../shared/ui/FocusItem.tsx";
import {
  pauseSpatialNavigation,
  resumeSpatialNavigation,
  useFocusable,
} from "../../remote/spatial.ts";

type SettingsScreenProps = {
  initialRelayUrl?: string;
  /** 저장/인증 실패 등 이 화면으로 되돌아온 까닭. */
  notice?: string;
  onComplete: (settings: TvSettings) => void;
};

function FocusInput({
  label,
  value,
  onChange,
  placeholder,
  type,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      pauseSpatialNavigation();
      inputRef.current?.focus();
    },
  });

  return (
    <label className="field" ref={ref}>
      <span>{label}</span>
      <input
        ref={inputRef}
        data-testid={testId}
        type={type ?? "text"}
        value={value}
        placeholder={placeholder}
        style={focused ? { borderColor: "var(--accent)" } : undefined}
        onChange={(event) => onChange(event.target.value)}
        onClick={() => pauseSpatialNavigation()}
        onBlur={() => resumeSpatialNavigation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.stopPropagation();
            inputRef.current?.blur();
          }
        }}
      />
    </label>
  );
}

export function SettingsScreen({
  initialRelayUrl,
  notice,
  onComplete,
}: SettingsScreenProps) {
  const [relayInput, setRelayInput] = useState(initialRelayUrl ?? "");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 화면을 떠날 때 spatial nav 가 멈춘 채로 남지 않게 보험을 든다.
  useEffect(() => () => resumeSpatialNavigation(), []);

  const submit = () => {
    const result = buildSettings(relayInput, keyInput);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    onComplete(result.settings);
  };

  return (
    <div className="screen" data-testid="settings-screen">
      <h1 className="screen-title">a2d2 TV 설정</h1>
      <p className="screen-subtitle">
        릴레이 주소와 관전용 키(nsec)를 넣어 주세요. 개인키는 이 실행의
        메모리에만 두고, 앱을 닫으면 다시 입력합니다.
      </p>
      {notice ? <p className="status-line error">{notice}</p> : null}
      <div className="scroll-list">
        <FocusInput
          label="릴레이 주소"
          value={relayInput}
          onChange={setRelayInput}
          placeholder="wss://buzz.a2d2lab.com"
          testId="settings-relay"
        />
        <FocusInput
          label="관전용 키 (nsec 또는 hex)"
          value={keyInput}
          onChange={setKeyInput}
          placeholder="nsec1…"
          type="password"
          testId="settings-key"
        />
        <FocusItem onSelect={submit} autoFocus>
          <span className="item-title">이 세션에서 시작</span>
        </FocusItem>
        {error ? <p className="status-line error">{error}</p> : null}
      </div>
    </div>
  );
}
