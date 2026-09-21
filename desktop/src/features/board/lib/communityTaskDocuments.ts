import { DOC_PAGE_ID_PATTERN } from "@/shared/lib/docsPageLink";
import { normalizeRelayUrl } from "@/shared/lib/normalizeRelayUrl";

export type CommunityTaskDocument = {
  pageId: string;
  relayUrl: string;
  title: string;
};
export const MAX_TASK_DOCUMENTS = 20;

/** Validate the community boundary before storing or opening a reference. */
export function taskDocumentRelay(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return normalizeRelayUrl(url.href);
  } catch {
    return null;
  }
}

/** Malformed optional references must not hide the task itself. */
export function parseCommunityTaskDocuments(
  value: unknown,
): CommunityTaskDocument[] {
  if (!Array.isArray(value)) return [];
  const result: CommunityTaskDocument[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.pageId !== "string" ||
      !DOC_PAGE_ID_PATTERN.test(item.pageId) ||
      typeof item.relayUrl !== "string" ||
      typeof item.title !== "string"
    )
      continue;
    const relayUrl = taskDocumentRelay(item.relayUrl);
    if (!relayUrl) continue;
    const key = `${relayUrl}:${item.pageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      pageId: item.pageId,
      relayUrl,
      title: item.title.trim().slice(0, 256) || "Untitled document",
    });
    if (result.length === MAX_TASK_DOCUMENTS) break;
  }
  return result;
}
