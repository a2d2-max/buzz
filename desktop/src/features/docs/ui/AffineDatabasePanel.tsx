import * as React from "react";
import { useCommunityDatabasesContext } from "@/features/databases/ui/CommunityDatabasesProvider";
import { Button } from "@/shared/ui/button";
import { DocDatabaseBlock } from "./DocDatabaseBlock";

export type AffineDatabaseSelection = {
  blockId: string;
  databaseId: string;
  viewId: string | null;
};
/** Keep database writes in the community provider, outside the document iframe. */
export function AffineDatabasePanel({
  selection,
  onAttach,
  onClose,
  onSelectView,
}: {
  selection: AffineDatabaseSelection | null;
  onAttach: (databaseId: string) => void;
  onClose: () => void;
  onSelectView: (viewId: string) => void;
}) {
  const databases = useCommunityDatabasesContext();
  const [selectedId, setSelectedId] = React.useState("");
  const choices = [...databases.schemas.values()].filter(
    (schema) => !schema.deleted,
  );
  return (
    <section
      aria-label="Linked database editor"
      className="rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Linked database</h3>
        <Button size="xs" variant="outline" onClick={onClose}>
          Close database
        </Button>
      </div>
      {selection ? (
        <DocDatabaseBlock
          databaseId={selection.databaseId}
          viewId={selection.viewId}
          onSelectView={onSelectView}
        />
      ) : (
        <div className="flex items-center gap-2 py-3">
          <label className="text-sm">
            Database{" "}
            <select
              aria-label="Database to link"
              className="rounded border bg-background p-2"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Choose a database</option>
              {choices.map((schema) => (
                <option key={schema.id} value={schema.id}>
                  {schema.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            disabled={!choices.some((schema) => schema.id === selectedId)}
            onClick={() => onAttach(selectedId)}
          >
            Link database
          </Button>
          {databases.isLoading ? (
            <span role="status">Loading databases…</span>
          ) : null}
          {databases.isError ? (
            <span role="alert">Could not load databases.</span>
          ) : null}
        </div>
      )}
    </section>
  );
}
