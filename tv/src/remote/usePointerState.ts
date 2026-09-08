// 매직리모컨 포인터 ↔ 5-way 전환 감지.
// 포인터를 흔들면 커서가 나타나고(cursorStateChange visibility=true),
// 방향키를 누르면 사라진다. 커서가 보일 땐 포커스 링을 죽이지 않고 그대로
// 둔다 — "포커스가 어디 있는지 항상 보여라"가 webOS UX 규칙이라서다.
// 출처: https://webostv.developer.lge.com/develop/guides/magic-remote

import { useEffect, useState } from "react";

type CursorStateChangeEvent = Event & {
  detail?: { visibility?: boolean };
};

export function usePointerState(): boolean {
  const [pointerVisible, setPointerVisible] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const visibility = (event as CursorStateChangeEvent).detail?.visibility;
      if (typeof visibility === "boolean") {
        setPointerVisible(visibility);
        document.body.classList.toggle("pointer-mode", visibility);
      }
    };
    document.addEventListener("cursorStateChange", handler);
    return () => document.removeEventListener("cursorStateChange", handler);
  }, []);

  return pointerVisible;
}
