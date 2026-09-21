import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { isCommunityTaskStatus } from "./communityTaskCodec";
import type {
  CommunityTaskFilters,
  CommunityTaskSort,
} from "./communityTaskView";

export type CommunityTaskViewSettings = {
  layout: "board" | "list" | "timeline";
  filters: CommunityTaskFilters;
  sort: CommunityTaskSort;
};
export type CommunityTaskSavedView = CommunityTaskViewSettings & {
  name: string;
};
export const MAX_SAVED_VIEWS = 20;
export const MAX_VIEW_NAME = 80;
export const MAX_VIEW_SEARCH = 500;
const MAX_STORAGE_LENGTH = 40_000;

/** Personal, device-local preferences never share a key across communities or users. */
export function communityTaskSavedViewsKey(
  relayUrl: string,
  viewer: string | null,
): string | null {
  const user = viewer ? normalizePubkey(viewer) : "";
  if (!relayUrl || !/^[a-f0-9]{64}$/.test(user)) return null;
  return `buzz-community-task-views.v1:${JSON.stringify([relayUrl, user])}`;
}

function isSavedView(value: unknown): value is CommunityTaskSavedView {
  if (!value || typeof value !== "object") return false;
  const view = value as CommunityTaskSavedView;
  const filters = view.filters;
  return (
    typeof view.name === "string" &&
    view.name.trim() === view.name &&
    view.name.length > 0 &&
    view.name.length <= MAX_VIEW_NAME &&
    ["board", "list", "timeline"].includes(view.layout) &&
    ["manual", "due", "updated", "title"].includes(view.sort) &&
    !!filters &&
    typeof filters === "object" &&
    typeof filters.search === "string" &&
    filters.search.length <= MAX_VIEW_SEARCH &&
    (filters.status === "all" || isCommunityTaskStatus(filters.status)) &&
    ["all", "overdue", "today", "none"].includes(filters.due) &&
    typeof filters.assignee === "string" &&
    (["all", "mine", "unassigned"].includes(filters.assignee) ||
      /^[a-f0-9]{64}$/.test(filters.assignee))
  );
}

function validateViews(value: unknown): CommunityTaskSavedView[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SAVED_VIEWS ||
    !value.every(isSavedView) ||
    new Set(value.map((view) => view.name.toLocaleLowerCase())).size !==
      value.length
  ) {
    throw new Error(
      "Saved views are invalid. Existing storage has been preserved.",
    );
  }
  return value.map(({ name, layout, sort, filters }) => ({
    name,
    layout,
    sort,
    filters: {
      search: filters.search,
      status: filters.status,
      assignee: filters.assignee,
      due: filters.due,
    },
  }));
}

/** Fail visibly instead of interpreting damaged or inaccessible storage as an empty collection. */
export function readCommunityTaskSavedViews(
  key: string,
): CommunityTaskSavedView[] {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return [];
  if (raw.length > MAX_STORAGE_LENGTH)
    throw new Error("Saved views exceed the storage limit.");
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1)
      throw new Error("Unsupported saved views version.");
    return validateViews(data.views);
  } catch {
    throw new Error(
      "Could not read saved views. Existing storage has been preserved.",
    );
  }
}

/** Write atomically; quota recovery evicts only disposable caches. Errors leave UI drafts available for retry. */
export function writeCommunityTaskSavedViews(
  key: string,
  views: CommunityTaskSavedView[],
): void {
  const value = JSON.stringify({ version: 1, views: validateViews(views) });
  if (value.length > MAX_STORAGE_LENGTH)
    throw new Error("Saved views exceed the storage limit.");
  if (!setLocalStorageItemWithRecovery(key, value))
    throw new Error(
      "Could not save views on this device. Free storage and try again.",
    );
}

export const COMMUNITY_TASK_VIEWS_D_TAG = "community-task-views.v1";
export type RemoteCommunityTaskViews = {
  views: CommunityTaskSavedView[];
  event: RelayEvent | null;
};

/** Fail closed on an unexpected author, address or malformed encrypted snapshot. */
export async function decodeRemoteCommunityTaskViews(
  event: RelayEvent,
  user: string,
): Promise<RemoteCommunityTaskViews> {
  const ds = event.tags.filter((tag) => tag[0] === "d");
  if (
    event.pubkey !== user ||
    event.kind !== 30078 ||
    ds.length !== 1 ||
    ds[0][1] !== COMMUNITY_TASK_VIEWS_D_TAG
  )
    throw new Error("Unexpected saved views identity or address.");
  const plain = await nip44DecryptFromSelf(event.content);
  if (plain.length > MAX_STORAGE_LENGTH)
    throw new Error("Saved views exceed the storage limit.");
  const value = JSON.parse(plain);
  if (value?.version !== 1) throw new Error("Unsupported saved views version.");
  return { views: validateViews(value.views), event };
}

/** The relay is authoritative; an unavailable or unreadable head never becomes an empty store. */
export async function fetchRemoteCommunityTaskViews(
  user: string,
): Promise<RemoteCommunityTaskViews> {
  if (!/^[a-f0-9]{64}$/.test(user))
    throw new Error("Sign in to load personal views.");
  const events = await relayClient.fetchEvents({
    kinds: [30078],
    authors: [user],
    "#d": [COMMUNITY_TASK_VIEWS_D_TAG],
    limit: 1,
  });
  return events.length
    ? decodeRemoteCommunityTaskViews(events[0], user)
    : { views: [], event: null };
}

/** Encrypt and persist one explicit snapshot. A changed head requires a reload instead of a blind overwrite. */
export async function saveRemoteCommunityTaskViews(
  user: string,
  views: CommunityTaskSavedView[],
  expected: RelayEvent | null,
  isCurrent: () => boolean,
): Promise<RemoteCommunityTaskViews> {
  const check = () => {
    if (!isCurrent())
      throw new Error("Account or community changed. Reopen personal views.");
  };
  check();
  const valid = validateViews(views);
  const fresh = await fetchRemoteCommunityTaskViews(user);
  check();
  if ((fresh.event?.id ?? null) !== (expected?.id ?? null))
    throw new Error(
      "Saved views changed on another device. Reload views and try again.",
    );
  const content = await nip44EncryptToSelf(
    JSON.stringify({ version: 1, views: valid }),
  );
  check();
  const event = await signRelayEvent({
    kind: 30078,
    content,
    tags: [["d", COMMUNITY_TASK_VIEWS_D_TAG]],
    createdAt: Math.max(
      Math.floor(Date.now() / 1000),
      (fresh.event?.created_at ?? 0) + 1,
    ),
  });
  check();
  if (event.pubkey !== user)
    throw new Error("Account changed while signing personal views.");
  await relayClient.publishEvent(
    event,
    "Timed out saving personal views.",
    "Failed to save personal views.",
  );
  check();
  return { views: valid, event };
}
