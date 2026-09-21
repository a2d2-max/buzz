import type { Components } from "react-markdown";

type MarkdownComponentSet = { components: Components; variant: string };

type MarkdownComponentFlags = {
  blockCode: boolean;
  docsDatabases: boolean;
  interactive: boolean;
  leadingInlineContent: boolean;
  mediaInset: boolean;
};

type MarkdownComponentFactory = (
  interactive: boolean,
  mediaInset: boolean,
  blockCode: boolean,
) => Components;

const MARKDOWN_COMPONENT_SCHEMA_VERSION = "8";
const markdownComponentsByVariant = new Map<string, MarkdownComponentSet>();

/**
 * Returns a module-stable component map and a matching parse-cache variant.
 * All render flags share this boundary so a new parse variant cannot reuse a
 * cached element tree produced under different behavior.
 */
export function getMarkdownComponents(
  flags: MarkdownComponentFlags,
  createComponents: MarkdownComponentFactory,
): MarkdownComponentSet {
  const variant = `${MARKDOWN_COMPONENT_SCHEMA_VERSION}:${flags.interactive ? "i" : ""}${flags.leadingInlineContent ? "l" : ""}${flags.mediaInset ? "m" : ""}${flags.blockCode ? "c" : ""}${flags.docsDatabases ? "d" : ""}`;
  let entry = markdownComponentsByVariant.get(variant);
  if (!entry) {
    entry = {
      components: createComponents(
        flags.interactive,
        flags.mediaInset,
        flags.blockCode,
      ),
      variant,
    };
    markdownComponentsByVariant.set(variant, entry);
  }
  return entry;
}
