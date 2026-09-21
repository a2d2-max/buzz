import { useMarkdownRuntime } from "./runtimeContext";

export function MarkdownDocDatabaseBlock(props: Record<string, unknown>) {
  const { renderDocDatabase } = useMarkdownRuntime();
  const databaseId = String(props["data-database-id"] ?? "");
  const viewId =
    typeof props["data-view-id"] === "string" ? props["data-view-id"] : null;

  return renderDocDatabase ? (
    renderDocDatabase(databaseId, viewId)
  ) : (
    <p>{`:::db ${databaseId}${viewId ? ` ${viewId}` : ""}`}</p>
  );
}
