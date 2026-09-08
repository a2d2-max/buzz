import { Search, UserPlus, X } from "lucide-react";
import * as React from "react";

import { useUserSearchQuery } from "@/features/profile/hooks";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  CommunityTaskAvatar,
  communityTaskProfileLabel,
} from "./CommunityTaskAssignees";

const SEARCH_PANEL_ID = "community-task-assign-search-panel";

/**
 * The assignee list of one card, editable in place: remove with the ✕ on a
 * chip, add yourself with one click, or search the community. The picker
 * only edits the list it is given — persisting is the sheet's job.
 */
export function CommunityTaskAssigneePicker({
  assignees,
  disabled = false,
  labelledBy,
  onChange,
  profiles,
  viewerPubkey,
}: {
  assignees: string[];
  disabled?: boolean;
  /** id of the visible "Assignees" heading; names the whole group. */
  labelledBy: string;
  onChange: (assignees: string[]) => void;
  profiles?: UserProfileLookup;
  viewerPubkey: string | null;
}) {
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query.trim());
  const searchQuery = useUserSearchQuery(deferredQuery, {
    allowEmpty: true,
    enabled: searchOpen && !disabled,
    limit: 50,
  });
  const current = React.useMemo(() => new Set(assignees), [assignees]);
  const viewer = viewerPubkey ? normalizePubkey(viewerPubkey) : null;
  const candidates = React.useMemo(
    () =>
      (searchQuery.data ?? []).filter(
        (user) => !current.has(normalizePubkey(user.pubkey)),
      ),
    [current, searchQuery.data],
  );

  const add = (pubkey: string) => {
    const normalized = normalizePubkey(pubkey);
    if (current.has(normalized)) return;
    onChange([...assignees, normalized]);
    setQuery("");
  };
  const remove = (pubkey: string) => {
    onChange(assignees.filter((candidate) => candidate !== pubkey));
  };

  return (
    <fieldset
      aria-labelledby={labelledBy}
      className="m-0 min-w-0 space-y-2 border-0 p-0"
      data-testid="community-task-assignee-picker"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {assignees.map((pubkey) => {
          const label = communityTaskProfileLabel(pubkey, profiles);
          return (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 py-0.5 pr-1 pl-0.5 text-xs"
              data-testid="community-task-assignee-chip"
              key={pubkey}
            >
              <CommunityTaskAvatar profiles={profiles} pubkey={pubkey} />
              <span className="max-w-32 truncate">{label}</span>
              {disabled ? null : (
                <button
                  aria-label={`Unassign ${label}`}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`community-task-unassign-${pubkey}`}
                  onClick={() => remove(pubkey)}
                  type="button"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
        {assignees.length === 0 ? (
          <span className="text-xs text-muted-foreground/70">Unassigned</span>
        ) : null}
      </div>
      {disabled ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {viewer && !current.has(viewer) ? (
            <Button
              data-testid="community-task-assign-self"
              onClick={() => add(viewer)}
              size="xs"
              type="button"
              variant="outline"
            >
              <UserPlus aria-hidden="true" />
              Assign to me
            </Button>
          ) : null}
          <Button
            aria-controls={searchOpen ? SEARCH_PANEL_ID : undefined}
            aria-expanded={searchOpen}
            data-testid="community-task-assign-search-toggle"
            onClick={() => setSearchOpen((open) => !open)}
            size="xs"
            type="button"
            variant="outline"
          >
            <Search aria-hidden="true" />
            {searchOpen ? "Close search" : "Find people"}
          </Button>
        </div>
      )}
      {searchOpen && !disabled ? (
        <div
          className="space-y-1.5 rounded-lg border border-border/60 p-2"
          id={SEARCH_PANEL_ID}
        >
          <Input
            aria-label="Search people to assign"
            className="h-8 text-xs"
            data-testid="community-task-assign-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name"
            value={query}
          />
          <ul
            className="max-h-48 space-y-0.5 overflow-y-auto"
            data-testid="community-task-assign-results"
          >
            {searchQuery.isLoading ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                Searching…
              </li>
            ) : candidates.length === 0 ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">
                {searchQuery.isError ? "Search failed." : "No one found."}
              </li>
            ) : (
              candidates.map((user) => {
                const label =
                  user.displayName?.trim() ||
                  user.nip05Handle?.trim() ||
                  truncatePubkey(user.pubkey);
                return (
                  <li key={user.pubkey}>
                    <button
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                      data-testid={`community-task-assign-${normalizePubkey(user.pubkey)}`}
                      onClick={() => add(user.pubkey)}
                      type="button"
                    >
                      <UserAvatar
                        accent={user.isAgent}
                        avatarUrl={user.avatarUrl}
                        displayName={label}
                        shape={user.isAgent ? "squircle" : "circle"}
                        size="xs"
                      />
                      <span className="truncate">{label}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}
