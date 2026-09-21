import * as React from "react";
import {
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  readCommunityTaskSavedViews,
  writeCommunityTaskSavedViews,
  type CommunityTaskSavedView,
  type CommunityTaskViewSettings,
} from "../lib/communityTaskSavedViews";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not access saved views on this device.";
}
function load(key: string) {
  try {
    return { views: readCommunityTaskSavedViews(key), error: "" };
  } catch (error) {
    return { views: [] as CommunityTaskSavedView[], error: message(error) };
  }
}

/** Named personal snapshots. Selecting applies all settings; editing does not overwrite a saved view. */
export function CommunityTaskSavedViews({
  storageKey,
  settings,
  onApply,
}: {
  storageKey: string;
  settings: CommunityTaskViewSettings;
  onApply: (settings: CommunityTaskViewSettings) => void;
}) {
  const [loaded, setLoaded] = React.useState(() => load(storageKey));
  const [error, setError] = React.useState("");
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const mutate = (
    change: (views: CommunityTaskSavedView[]) => CommunityTaskSavedView[],
  ) => {
    try {
      // Re-read before every mutation so another open panel's saves are preserved.
      const views = change(readCommunityTaskSavedViews(storageKey));
      writeCommunityTaskSavedViews(storageKey, views);
      setLoaded({ views, error: "" });
      setError("");
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3">
      <span className="text-xs text-muted-foreground">
        Personal views · On this device
      </span>
      <select
        aria-label="Saved task views"
        value={selected}
        className="h-8 max-w-48 rounded-md border border-border/60 bg-background px-2 text-xs"
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Choose a view</option>
        {loaded.views.map((view) => (
          <option key={view.name} value={view.name}>
            {view.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!selected}
        onClick={() => {
          const fresh = load(storageKey);
          setLoaded(fresh);
          if (fresh.error) {
            setError(fresh.error);
            return;
          }
          const view = fresh.views.find((view) => view.name === selected);
          if (!view) {
            setSelected("");
            setError("This saved view was deleted. Choose another view.");
            return;
          }
          setError("");
          onApply({ ...view, filters: { ...view.filters } });
        }}
      >
        Apply view
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!selected}
        onClick={() => {
          if (mutate((views) => views.filter((view) => view.name !== selected)))
            setSelected("");
        }}
      >
        Delete view
      </Button>
      <Input
        aria-label="New view name"
        placeholder="Name this view…"
        className="h-8 w-40 text-xs"
        value={name}
        maxLength={MAX_VIEW_NAME}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!name.trim()}
        onClick={() => {
          const trimmed = name.trim();
          if (
            mutate((views) => {
              if (views.length >= MAX_SAVED_VIEWS)
                throw new Error(
                  `You can save up to ${MAX_SAVED_VIEWS} views. Delete a view first.`,
                );
              if (
                views.some(
                  (view) =>
                    view.name.toLocaleLowerCase() ===
                    trimmed.toLocaleLowerCase(),
                )
              )
                throw new Error(
                  "A view with this name already exists. Choose another name.",
                );
              return [
                ...views,
                {
                  ...settings,
                  filters: { ...settings.filters },
                  name: trimmed,
                },
              ];
            })
          ) {
            setSelected(trimmed);
            setName("");
          }
        }}
      >
        Save view
      </Button>
      {loaded.error || error ? (
        <div
          role="alert"
          className="flex w-full items-center gap-2 text-xs text-destructive"
        >
          {error || loaded.error}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setLoaded(load(storageKey));
              setError("");
            }}
          >
            Retry loading views
          </Button>
        </div>
      ) : null}
    </div>
  );
}
