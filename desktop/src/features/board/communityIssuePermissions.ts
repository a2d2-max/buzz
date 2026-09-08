import type { ProjectIssueBoardItem } from "@/features/projects/ui/ProjectIssueBoard";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type CommunityIssueMoveInput = {
  item: ProjectIssueBoardItem;
  /** Normalised pubkeys of the viewer's managed agents. */
  managedAgentPubkeys: ReadonlySet<string>;
  /**
   * True when the statuses section of the work-items fetch failed. Every
   * card then shows a label-derived fallback status, and a drop would publish
   * an authoritative status event on top of a state the viewer cannot see —
   * a closed task dragged to Triage from a stale Backlog column would reopen.
   */
  statusesUnavailable: boolean;
  /** Normalised viewer pubkey, or null while identity is unknown. */
  viewer: string | null;
};

/**
 * Who may move a card on the community board: the task author, the owner of
 * the repository the task lives in, or the owner of a managed agent that owns
 * that repository — the same three the per-project board trusts, checked per
 * card because every card may come from a different repository.
 */
export function canMoveCommunityIssue({
  item,
  managedAgentPubkeys,
  statusesUnavailable,
  viewer,
}: CommunityIssueMoveInput): boolean {
  if (statusesUnavailable || !viewer) return false;
  const owner = normalizePubkey(item.project.owner);
  return (
    viewer === normalizePubkey(item.issue.author) ||
    viewer === owner ||
    managedAgentPubkeys.has(owner)
  );
}

/**
 * Whether a move on this card must be signed by the managed agent that owns
 * the repository rather than by the viewer. Only meaningful for a card
 * `canMoveCommunityIssue` allows.
 */
export function communityIssueMoveSignsAsManagedOwner({
  item,
  managedAgentPubkeys,
  viewer,
}: Omit<CommunityIssueMoveInput, "statusesUnavailable">): boolean {
  const owner = normalizePubkey(item.project.owner);
  return managedAgentPubkeys.has(owner) && viewer !== owner;
}
