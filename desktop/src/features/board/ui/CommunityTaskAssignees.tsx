import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { UserAvatar } from "@/shared/ui/UserAvatar";

export function communityTaskProfile(
  pubkey: string,
  profiles?: UserProfileLookup,
) {
  return profiles?.[normalizePubkey(pubkey)] ?? null;
}

/** Display name, NIP-05 handle, or the compact pubkey — never a bare hex string. */
export function communityTaskProfileLabel(
  pubkey: string,
  profiles?: UserProfileLookup,
): string {
  const profile = communityTaskProfile(pubkey, profiles);
  return (
    profile?.displayName?.trim() ||
    profile?.nip05Handle?.trim() ||
    truncatePubkey(pubkey)
  );
}

export function CommunityTaskAvatar({
  profiles,
  pubkey,
  size = "xs",
}: {
  profiles?: UserProfileLookup;
  pubkey: string;
  size?: "xs" | "sm";
}) {
  const profile = communityTaskProfile(pubkey, profiles);
  return (
    <UserAvatar
      accent={profile?.isAgent === true}
      avatarUrl={profile?.avatarUrl ?? null}
      displayName={communityTaskProfileLabel(pubkey, profiles)}
      shape={profile?.isAgent ? "squircle" : "circle"}
      size={size}
    />
  );
}

/** Compact overlapping assignee avatars for a board card. */
export function CommunityTaskAssigneeFacepile({
  assignees,
  profiles,
}: {
  assignees: string[];
  profiles?: UserProfileLookup;
}) {
  if (assignees.length === 0) return null;
  const shown = assignees.slice(0, 3);
  const hidden = assignees.length - shown.length;
  return (
    <span
      className="flex shrink-0 items-center -space-x-1"
      data-testid="community-task-assignees"
    >
      {shown.map((pubkey) => {
        const profile = communityTaskProfile(pubkey, profiles);
        return (
          <span
            className={cn(
              "inline-flex ring-1 ring-background",
              profile?.isAgent ? "rounded-[30%]" : "rounded-full",
            )}
            key={pubkey}
            title={`Assigned to ${communityTaskProfileLabel(pubkey, profiles)}`}
          >
            <CommunityTaskAvatar profiles={profiles} pubkey={pubkey} />
          </span>
        );
      })}
      {hidden > 0 ? (
        <span className="pl-1.5 text-2xs text-muted-foreground/70">
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
