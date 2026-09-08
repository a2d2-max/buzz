// 방향키로 고를 수 있는 행/버튼 하나.
// - 5-way: norigin 이 포커스를 주고, OK(Enter)에 onSelect 를 부른다
// - 포인터: 그냥 onClick — 매직리모컨 포인터는 표준 마우스 이벤트로 들어온다
// 포커스가 오면 화면 밖이어도 보이게 스크롤한다.

import { type ReactNode, useEffect, useRef } from "react";
import { useFocusable } from "../../remote/spatial.ts";

type FocusItemProps = {
  children: ReactNode;
  onSelect: () => void;
  className?: string;
  /** 마운트될 때 이 항목에 포커스를 줄지(화면당 하나만). */
  autoFocus?: boolean;
  /** setFocus 로 바깥에서 포커스를 줄 때 쓰는 이름표. */
  focusKey?: string;
  testId?: string;
  channelId?: string;
  eventId?: string;
  docId?: string;
  docEventId?: string;
};

export function FocusItem({
  children,
  onSelect,
  className,
  autoFocus,
  focusKey,
  testId,
  channelId,
  eventId,
  docId,
  docEventId,
}: FocusItemProps) {
  const { ref, focused, focusSelf } = useFocusable({
    focusKey,
    onEnterPress: onSelect,
    onFocus: () => {
      (ref.current as HTMLElement | null)?.scrollIntoView({
        block: "nearest",
      });
    },
  });

  // autoFocus 는 첫 포커스 지정용 — 마운트 뒤 한 번만 효력이 있다.
  // (리렌더마다 focusSelf 가 다시 불리면 사용자의 포커스 이동을 빼앗는다)
  const didAutoFocus = useRef(false);
  useEffect(() => {
    if (autoFocus && !didAutoFocus.current) {
      didAutoFocus.current = true;
      focusSelf();
    }
  }, [autoFocus, focusSelf]);

  return (
    <button
      type="button"
      ref={ref}
      data-testid={testId}
      data-channel-id={channelId}
      data-event-id={eventId}
      data-doc-id={docId}
      data-doc-event-id={docEventId}
      className={`focusable ${focused ? "focused" : ""} ${className ?? ""}`}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
