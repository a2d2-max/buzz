export type AppEntryModeInput = {
  href: string;
  huddleChannelId: string | null;
};

export function shouldUseLegacyCommunityApp({
  href,
  huddleChannelId,
}: AppEntryModeInput): boolean {
  if (huddleChannelId !== null) return true;
  return new URL(href).searchParams.get("raouPrimary") !== "1";
}
