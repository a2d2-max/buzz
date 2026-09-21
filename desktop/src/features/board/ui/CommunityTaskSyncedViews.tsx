import * as React from "react";
import { relayClient } from "@/shared/api/relayClient";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  COMMUNITY_TASK_VIEWS_D_TAG,
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  fetchRemoteCommunityTaskViews,
  saveRemoteCommunityTaskViews,
  readCommunityTaskSavedViews,
  type RemoteCommunityTaskViews,
  type CommunityTaskViewSettings,
} from "../lib/communityTaskSavedViews";

/** Same-account encrypted views; local snapshots are imported only by an explicit action. */
export function CommunityTaskSyncedViews({
  user,
  storageKey,
  settings,
  onApply,
}: {
  user: string;
  storageKey: string;
  settings: CommunityTaskViewSettings;
  onApply: (settings: CommunityTaskViewSettings) => void;
}) {
  const [remote, setRemote] = React.useState<RemoteCommunityTaskViews | null>(
    null,
  );
  const [error, setError] = React.useState("");
  const [liveError, setLiveError] = React.useState("");
  const [subscriptionAttempt, retrySubscription] = React.useReducer(
    (n: number) => n + 1,
    0,
  );
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const current = React.useRef(false);
  const generation = React.useRef(0);
  const saving = React.useRef(false);
  const refresh = React.useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await fetchRemoteCommunityTaskViews(user);
      if (current.current && request === generation.current) {
        setRemote(result);
        setError("");
      }
    } catch (failure) {
      if (current.current && request === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load personal views.",
        );
    }
  }, [user]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry must recreate the live subscription.
  React.useEffect(() => {
    current.current = true;
    let dispose: (() => Promise<void>) | undefined;
    let disposed = false;
    const reload = () => {
      if (!disposed) void refresh();
    };
    // Register live before history. Ready and reconnect both reconcile a fresh snapshot.
    void relayClient
      .subscribeLive(
        {
          kinds: [30078],
          authors: [user],
          "#d": [COMMUNITY_TASK_VIEWS_D_TAG],
          limit: 0,
        },
        reload,
        reload,
      )
      .then((unsubscribe) => {
        if (disposed) void unsubscribe();
        else {
          setLiveError("");
          dispose = unsubscribe;
          reload();
        }
      })
      .catch((failure) => {
        if (!disposed)
          setLiveError(
            failure instanceof Error
              ? failure.message
              : "Could not subscribe to personal views.",
          );
      });
    const fallback = window.setTimeout(reload, 3000);
    const reconnect = relayClient.subscribeToReconnects(reload);
    window.addEventListener("focus", reload);
    return () => {
      disposed = true;
      current.current = false;
      generation.current++;
      window.clearTimeout(fallback);
      reconnect();
      window.removeEventListener("focus", reload);
      void dispose?.();
    };
  }, [refresh, user, subscriptionAttempt]);
  const save = async (views: RemoteCommunityTaskViews["views"]) => {
    if (!remote || saving.current) return false;
    saving.current = true;
    setBusy(true);
    ++generation.current;
    try {
      const result = await saveRemoteCommunityTaskViews(
        user,
        views,
        remote.event,
        () => current.current,
      );
      if (!current.current) return false;
      ++generation.current;
      setRemote(result);
      setError("");
      return true;
    } catch (failure) {
      if (current.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not save personal views.",
        );
      return false;
    } finally {
      saving.current = false;
      if (current.current) setBusy(false);
    }
  };
  const disabled = busy || !remote;
  return (
    <section
      aria-label="Personal views"
      className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3"
    >
      <span className="text-xs text-muted-foreground">
        Personal views · Synced across your devices
      </span>
      <select
        aria-label="Saved task views"
        value={selected}
        disabled={disabled}
        className="h-8 max-w-48 rounded-md border border-border/60 bg-background px-2 text-xs"
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Choose a view</option>
        {remote?.views.map((view) => (
          <option key={view.name} value={view.name}>
            {view.name}
          </option>
        ))}
      </select>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || !selected}
        onClick={async () => {
          try {
            const fresh = await fetchRemoteCommunityTaskViews(user);
            if (!current.current) return;
            ++generation.current;
            setRemote(fresh);
            const view = fresh.views.find((v) => v.name === selected);
            if (!view) {
              setSelected("");
              throw new Error(
                "This saved view was deleted. Choose another view.",
              );
            }
            setError("");
            onApply({ ...view, filters: { ...view.filters } });
          } catch (failure) {
            if (current.current)
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Could not apply view.",
              );
          }
        }}
      >
        Apply view
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || !selected}
        onClick={async () => {
          if (
            remote &&
            (await save(remote.views.filter((view) => view.name !== selected)))
          )
            setSelected("");
        }}
      >
        Delete view
      </Button>
      <Input
        aria-label="New view name"
        placeholder="Name this view…"
        value={name}
        maxLength={MAX_VIEW_NAME}
        disabled={busy}
        className="h-8 w-40 text-xs"
        onChange={(e) => setName(e.target.value)}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || !name.trim()}
        onClick={async () => {
          if (!remote) return;
          const trimmed = name.trim();
          if (remote.views.length >= MAX_SAVED_VIEWS) {
            setError("Delete a view before adding another.");
            return;
          }
          if (
            remote.views.some(
              (v) => v.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
            )
          ) {
            setError("A view with this name already exists.");
            return;
          }
          if (
            await save([
              ...remote.views,
              { ...settings, filters: { ...settings.filters }, name: trimmed },
            ])
          ) {
            setName("");
            setSelected(trimmed);
          }
        }}
      >
        Save view
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={async () => {
          try {
            if (!remote) return;
            const local = readCommunityTaskSavedViews(storageKey);
            const existing = new Set(
              remote.views.map((v) => v.name.toLocaleLowerCase()),
            );
            await save([
              ...remote.views,
              ...local.filter((v) => !existing.has(v.name.toLocaleLowerCase())),
            ]);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : "Could not import local views.",
            );
          }
        }}
      >
        Import views from this device
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          if (liveError) retrySubscription();
          else void refresh();
        }}
      >
        Reload views
      </Button>
      {!remote && !error && !liveError && (
        <span role="status" className="text-xs">
          Loading views…
        </span>
      )}
      {(error || liveError) && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error || liveError}
        </p>
      )}
    </section>
  );
}
