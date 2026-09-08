import { fromMarkdown } from "mdast-util-from-markdown";

export type MarkdownDestinationNode = {
  type?: string;
  url?: string;
  children?: MarkdownDestinationNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type Replacement = { start: number; end: number; value: string };

export type MarkdownDestination = {
  nodeType: "definition" | "image" | "link";
  url: string;
  start: number;
  end: number;
};

function walk(
  node: MarkdownDestinationNode,
  visit: (node: MarkdownDestinationNode) => void,
): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function markdownDestinationForNode(
  source: string,
  node: MarkdownDestinationNode,
): MarkdownDestination | null {
  if (
    (node.type !== "definition" &&
      node.type !== "image" &&
      node.type !== "link") ||
    typeof node.url !== "string"
  ) {
    return null;
  }
  const nodeStart = node.position?.start.offset;
  const nodeEnd = node.position?.end.offset;
  if (nodeStart === undefined || nodeEnd === undefined) return null;
  const nodeSource = source.slice(nodeStart, nodeEnd);

  let destinationStart: number;
  if (node.type === "definition") {
    const delimiter = nodeSource.lastIndexOf("]:");
    if (delimiter < 0) return null;
    destinationStart = delimiter + 2;
  } else if (nodeSource.startsWith("<") && nodeSource.endsWith(">")) {
    destinationStart = 1;
  } else {
    const delimiter = nodeSource.lastIndexOf("](");
    if (delimiter < 0) return null;
    destinationStart = delimiter + 2;
  }

  while (/\s/.test(nodeSource[destinationStart] ?? "")) {
    destinationStart += 1;
  }
  if (nodeSource[destinationStart] === "<") destinationStart += 1;
  const relativeStart = nodeSource.indexOf(node.url, destinationStart);
  if (relativeStart < 0) return null;
  return {
    nodeType: node.type,
    url: node.url,
    start: nodeStart + relativeStart,
    end: nodeStart + relativeStart + node.url.length,
  };
}

/** Return only parser-recognized Markdown link/image/definition destinations. */
export function collectMarkdownDestinations(
  source: string,
): MarkdownDestination[] {
  const destinations: MarkdownDestination[] = [];
  walk(fromMarkdown(source) as MarkdownDestinationNode, (node) => {
    const destination = markdownDestinationForNode(source, node);
    if (destination) destinations.push(destination);
  });
  return destinations;
}

/**
 * Rewrite destination spans selected by `replacementFor`. Labels, titles,
 * prose, and parser-recognized code ranges are never searched or replaced.
 */
export function rewriteMarkdownDestinations(
  source: string,
  replacementFor: (destination: MarkdownDestination) => string | null,
): { body: string; replacementCount: number } {
  const replacements: Replacement[] = [];
  for (const destination of collectMarkdownDestinations(source)) {
    const value = replacementFor(destination);
    if (value === null) continue;
    replacements.push({
      start: destination.start,
      end: destination.end,
      value,
    });
  }

  let body = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    body =
      body.slice(0, replacement.start) +
      replacement.value +
      body.slice(replacement.end);
  }
  return { body, replacementCount: replacements.length };
}
