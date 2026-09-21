import * as React from "react";
import {
  type CommunityTaskDocument,
  MAX_TASK_DOCUMENTS,
  taskDocumentRelay,
} from "@/features/board/lib/communityTaskDocuments";
import { buildDocsPageLink } from "@/shared/lib/docsPageLink";
import { Button } from "@/shared/ui/button";
import { CommunityTaskDocumentPicker } from "./CommunityTaskDocumentPicker";

/** Links and draft selection share the task's existing Save action. */
export function CommunityTaskDocuments({
  documents,
  onChange,
  relayUrl,
  readonly,
  disabled,
  onOpenDocument,
}: {
  documents: CommunityTaskDocument[];
  onChange: (documents: CommunityTaskDocument[]) => void;
  relayUrl: string;
  readonly: boolean;
  disabled: boolean;
  onOpenDocument?: (pageId: string) => void;
}) {
  const [choosing, setChoosing] = React.useState(false);
  const headingId = React.useId();
  const activeRelay = taskDocumentRelay(relayUrl);
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-xs font-medium text-muted-foreground">
        Linked documents
      </h3>
      <ul className="space-y-2">
        {documents.map((document, index) => {
          const local =
            activeRelay !== null &&
            activeRelay === taskDocumentRelay(document.relayUrl);
          return (
            <li
              key={`${document.relayUrl}:${document.pageId}`}
              className="flex items-start justify-between gap-2 text-xs"
            >
              <div className="min-w-0 break-words">
                {local ? (
                  <a
                    href={buildDocsPageLink(document.pageId)}
                    className="text-primary underline underline-offset-2"
                    onClick={(event) => {
                      if (disabled) {
                        event.preventDefault();
                        return;
                      }
                      if (
                        onOpenDocument &&
                        event.button === 0 &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.shiftKey &&
                        !event.altKey
                      ) {
                        event.preventDefault();
                        onOpenDocument(document.pageId);
                      }
                    }}
                  >
                    {document.title}
                  </a>
                ) : (
                  <>
                    <span>{document.title}</span>
                    <p className="text-muted-foreground">
                      Switch to this document’s community to open it.
                    </p>
                  </>
                )}
              </div>
              {!readonly ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove document ${document.title}`}
                  onClick={() =>
                    onChange(documents.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {documents.length === 0 ? (
        <p className="text-xs text-muted-foreground">No linked documents.</p>
      ) : null}
      {!readonly ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={
              disabled || !activeRelay || documents.length >= MAX_TASK_DOCUMENTS
            }
            onClick={() => setChoosing((value) => !value)}
          >
            {choosing ? "Close document picker" : "Link a document"}
          </Button>
          {documents.length >= MAX_TASK_DOCUMENTS ? (
            <p className="text-xs text-muted-foreground">
              Up to {MAX_TASK_DOCUMENTS} documents per task.
            </p>
          ) : null}
          {choosing && activeRelay ? (
            <CommunityTaskDocumentPicker
              linked={documents}
              relayUrl={activeRelay}
              disabled={disabled || documents.length >= MAX_TASK_DOCUMENTS}
              onSelect={(document) => {
                onChange([...documents, document]);
                setChoosing(false);
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
