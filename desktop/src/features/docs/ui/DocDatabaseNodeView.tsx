import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

import { useOptionalCommunityDatabasesContext } from "@/features/databases/ui/CommunityDatabasesProvider";

import { DocDatabaseBlock } from "./DocDatabaseBlock";

/** React portal for the database atom; database events stay outside ProseMirror. */
export function DocDatabaseNodeView({
  deleteNode,
  node,
  selected,
  updateAttributes,
}: ReactNodeViewProps) {
  const databases = useOptionalCommunityDatabasesContext();
  const databaseId = String(node.attrs.databaseId ?? "");
  const viewId =
    typeof node.attrs.viewId === "string" ? node.attrs.viewId : null;
  return (
    <NodeViewWrapper
      className={selected ? "rounded-xl ring-2 ring-ring/50" : ""}
      contentEditable={false}
      data-doc-database-node=""
      data-database-id={databaseId}
      data-view-id={viewId ?? undefined}
    >
      {databases ? (
        <DocDatabaseBlock
          databaseId={databaseId}
          onRemove={deleteNode}
          onSelectView={(nextViewId) => {
            if (nextViewId !== viewId) updateAttributes({ viewId: nextViewId });
          }}
          viewId={viewId}
        />
      ) : (
        <div className="my-3 rounded-xl border border-border/70 p-4 text-sm text-muted-foreground">
          Linked database
        </div>
      )}
    </NodeViewWrapper>
  );
}
