// Docs 문서 뷰어. 본문 전체를 한 덩어리 마크다운으로 그리고,
// 위아래 방향키로 문서를 넘겨 볼 수 있게 스크롤 페이지를 포커스 대상으로 삼는다.

import { useEffect, useRef } from "react";

import { Markdown } from "../../shared/ui/Markdown.tsx";
import { useFocusable } from "../../remote/spatial.ts";
import type { DocListEntry } from "./docCodec.ts";

const SCROLL_STEP_PX = 240;

export function DocViewerScreen({ doc }: { doc: DocListEntry }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 문서 본문 자체가 포커스 하나를 차지한다: 위아래 키가 스크롤이 된다.
  const { ref, focused, focusSelf } = useFocusable({
    onArrowPress: (direction) => {
      const el = scrollRef.current;
      if (!el) return true;
      if (direction === "down") {
        el.scrollBy({ top: SCROLL_STEP_PX });
        return false; // 포커스 이동을 막는다 — 스크롤로 소비했다
      }
      if (direction === "up") {
        if (el.scrollTop <= 0) return true;
        el.scrollBy({ top: -SCROLL_STEP_PX });
        return false;
      }
      return true;
    },
  });

  // 문서가 뜨면 본문에 포커스를 준다 — 한 번만(스크롤 중 재포커스 방지).
  const didFocus = useRef(false);
  useEffect(() => {
    if (!didFocus.current) {
      didFocus.current = true;
      focusSelf();
    }
  }, [focusSelf]);

  return (
    <div
      className="screen"
      data-testid="doc-viewer-screen"
      data-doc-id={doc.id}
      data-doc-event-id={doc.eventId}
    >
      <h1 className="screen-title">
        {doc.icon ? `${doc.icon} ` : ""}
        {doc.title || "(제목 없음)"}
      </h1>
      <div
        ref={ref}
        className={`scroll-list focusable ${focused ? "focused" : ""}`}
        style={{ display: "block" }}
      >
        <div ref={scrollRef} style={{ height: "100%", overflowY: "auto" }}>
          <Markdown source={doc.body} />
        </div>
      </div>
    </div>
  );
}
