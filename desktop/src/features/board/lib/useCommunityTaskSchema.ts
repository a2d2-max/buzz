import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { fetchCommunityTaskAppData } from "./communityTaskRelay";
import {
  COMMUNITY_TASK_FIELD_PREFIX,
  parseCommunityTaskFieldDefinition,
  type CommunityTaskFieldDefinition,
  type CommunityTaskCustomField,
} from "./communityTaskCustomFields";

/** Community-readable, signer-owned field definitions. Account/community switches retire in-flight writes. */
export function useCommunityTaskSchema(relayUrl: string, user: string | null) {
  const client = useQueryClient();
  const key = React.useMemo(
    () => ["community-task-fields", relayUrl],
    [relayUrl],
  );
  const current = React.useRef("");
  const scope = JSON.stringify([relayUrl, user]);
  current.current = scope;
  const query = useQuery({
    queryKey: key,
    enabled: !!relayUrl,
    queryFn: async () => {
      const events = await fetchCommunityTaskAppData((event) =>
        event.tags.some(
          (tag) =>
            tag[0] === "d" && tag[1]?.startsWith(COMMUNITY_TASK_FIELD_PREFIX),
        ),
      );
      const latest = new Map<string, CommunityTaskFieldDefinition>();
      for (const event of events) {
        const field = parseCommunityTaskFieldDefinition(event);
        if (!field)
          throw new Error(
            "A shared field definition is invalid. Existing values have been preserved.",
          );
        const old = latest.get(field.key);
        if (
          !old ||
          event.created_at > old.event.created_at ||
          (event.created_at === old.event.created_at && event.id < old.event.id)
        )
          latest.set(field.key, field);
      }
      return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  });
  React.useEffect(() => {
    current.current = scope;
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | undefined;
    const refresh = () => {
      if (!disposed) void client.invalidateQueries({ queryKey: key });
    };
    void relayClient
      .subscribeLive(
        { kinds: [30078], "#t": ["community-task-field"], limit: 0 },
        refresh,
        refresh,
      )
      .then((stop) => {
        if (disposed) void stop();
        else {
          unsubscribe = stop;
          refresh();
        }
      })
      .catch(refresh);
    const reconnect = relayClient.subscribeToReconnects(refresh);
    return () => {
      disposed = true;
      current.current = "";
      reconnect();
      void unsubscribe?.();
    };
  }, [client, key, scope]);
  const save = async (
    draft: {
      name: string;
      type: CommunityTaskCustomField["type"];
      archived: boolean;
    },
    existing?: CommunityTaskFieldDefinition,
  ) => {
    const check = () => {
      if (current.current !== scope)
        throw new Error("Account or community changed. Reopen shared fields.");
    };
    check();
    if (!user || (existing && existing.owner !== user))
      throw new Error("Only the definition creator can change this field.");
    const id = existing?.id ?? crypto.randomUUID();
    if (existing && existing.type !== draft.type)
      throw new Error("Create a new field to use a different type.");
    const heads = await relayClient.fetchEvents({
      kinds: [30078],
      authors: [user],
      "#d": [COMMUNITY_TASK_FIELD_PREFIX + id],
      limit: 1,
    });
    check();
    if ((heads[0]?.id ?? null) !== (existing?.event.id ?? null))
      throw new Error("This field changed elsewhere. Reload before editing.");
    const event = await signRelayEvent({
      kind: 30078,
      content: JSON.stringify({
        version: 1,
        ...draft,
        name: draft.name.trim(),
      }),
      tags: [
        ["d", COMMUNITY_TASK_FIELD_PREFIX + id],
        ["t", "community-task-field"],
      ],
      createdAt: Math.max(
        Math.floor(Date.now() / 1000),
        (heads[0]?.created_at ?? 0) + 1,
      ),
    });
    check();
    if (event.pubkey !== user || !parseCommunityTaskFieldDefinition(event))
      throw new Error("Invalid shared field or changed account.");
    await relayClient.publishEvent(
      event,
      "Timed out saving shared field.",
      "Failed to save shared field.",
    );
    check();
    await client.invalidateQueries({ queryKey: key });
  };
  return { query, save };
}
