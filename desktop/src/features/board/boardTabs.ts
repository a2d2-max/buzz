export type BoardTab = "issues" | "tasks";

export const BOARD_TABS: readonly BoardTab[] = ["issues", "tasks"];

export const DEFAULT_BOARD_TAB: BoardTab = "issues";

/** Narrows a `?tab=` search value; anything unknown falls back to `null`. */
export function parseBoardTab(value: unknown): BoardTab | null {
  return typeof value === "string" && BOARD_TABS.includes(value as BoardTab)
    ? (value as BoardTab)
    : null;
}
