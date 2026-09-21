import * as React from "react";
import { useCommunityDocs } from "@/features/docs/lib/useCommunityDocs";
import type { CommunityTaskDocument } from "@/features/board/lib/communityTaskDocuments";
import { Input } from "@/shared/ui/input";
import { Button } from "@/shared/ui/button";

/** Mounted only while choosing a document, using the existing community-scoped store. */
export function CommunityTaskDocumentPicker({
  linked,
  onSelect,
  relayUrl,
  disabled,
}: {
  linked: CommunityTaskDocument[];
  onSelect: (document: CommunityTaskDocument) => void;
  relayUrl: string;
  disabled: boolean;
}) {
  const docs = useCommunityDocs();
  const [search, setSearch] = React.useState("");
  const [retryError, setRetryError] = React.useState(false);
  const matches = [...docs.pages.values()]
    .filter(
      (page) =>
        !page.deleted &&
        page.title
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()) &&
        !linked.some(
          (ref) => ref.relayUrl === relayUrl && ref.pageId === page.id,
        ),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2">
      <Input
        aria-label="Search documents"
        placeholder="Search documents…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={disabled}
        className="h-8 text-xs"
      />
      {docs.isLoading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading documents…
        </p>
      ) : null}
      {docs.isError || docs.truncated || retryError ? (
        <div className="text-xs text-muted-foreground" role="status">
          {docs.isError || retryError
            ? "Could not load all documents."
            : "Some documents may be missing from this list."}
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={() => {
              setRetryError(false);
              void docs.refetch().catch(() => setRetryError(true));
            }}
          >
            Retry documents
          </Button>
        </div>
      ) : null}
      <ul className="max-h-48 overflow-y-auto" aria-label="Available documents">
        {matches.slice(0, 100).map((page) => (
          <li key={page.id}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start truncate"
              disabled={disabled}
              onClick={() =>
                onSelect({
                  pageId: page.id,
                  relayUrl,
                  title: page.title || "Untitled document",
                })
              }
            >
              {page.title || "Untitled document"}
            </Button>
          </li>
        ))}
      </ul>
      {!docs.isLoading && !docs.isError && matches.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No available documents match.
        </p>
      ) : null}
      {matches.length > 100 ? (
        <p className="text-xs text-muted-foreground">
          Showing 100 documents. Narrow your search to find more.
        </p>
      ) : null}
    </div>
  );
}
