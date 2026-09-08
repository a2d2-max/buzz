// Docs 목록. 전용 kind 30623 + 레거시 30078 을 함께 조회해
// 페이지별 최신 판만 트리 순서로 보여 준다.

import { useEffect, useState } from "react";
import type { RelayConnection } from "../../shared/lib/relay.ts";
import {
  COMMUNITY_DOC_QUERY_KINDS,
  COMMUNITY_DOC_TAG,
} from "../../shared/lib/kinds.ts";
import { FocusItem } from "../../shared/ui/FocusItem.tsx";
import { buildDocList, type DocListEntry } from "./docCodec.ts";

export function DocsListScreen({
  relay,
  onOpenDoc,
}: {
  relay: RelayConnection;
  onOpenDoc: (doc: DocListEntry) => void;
}) {
  const [docs, setDocs] = useState<DocListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    relay
      .queryOnce({
        kinds: [...COMMUNITY_DOC_QUERY_KINDS],
        "#t": [COMMUNITY_DOC_TAG],
        limit: 500,
      })
      .then((events) => {
        if (alive) setDocs(buildDocList(events));
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
    <div className="screen" data-testid="docs-list-screen">
      <h1 className="screen-title">Docs</h1>
      {error ? (
        <p className="status-line error">
          문서 목록을 못 불러왔습니다: {error}
        </p>
      ) : null}
      {docs === null && !error ? (
        <p className="status-line">불러오는 중…</p>
      ) : null}
      {docs !== null && docs.length === 0 ? (
        <p className="status-line">문서가 없습니다.</p>
      ) : null}
      <div className="scroll-list">
        {docs?.map((doc, index) => (
          <FocusItem
            key={doc.id}
            onSelect={() => onOpenDoc(doc)}
            autoFocus={index === 0}
            docId={doc.id}
            docEventId={doc.eventId}
          >
            <span style={{ paddingLeft: `${doc.depth * 40}px` }}>
              {doc.icon ? `${doc.icon} ` : "📄 "}
              <span className="item-title">{doc.title || "(제목 없음)"}</span>
            </span>
          </FocusItem>
        ))}
      </div>
    </div>
  );
}
