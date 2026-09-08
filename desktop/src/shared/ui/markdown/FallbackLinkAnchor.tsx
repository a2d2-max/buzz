import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { parseDocsPageLink } from "@/shared/lib/docsPageLink";

import { ExternalLinkAnchor } from "./ExternalLinkAnchor";

type FallbackLinkAnchorProps = {
  anchorProps: React.ComponentPropsWithoutRef<"a">;
  children: React.ReactNode;
  href: string | undefined;
  isLinearLink: boolean;
  label: string;
};

/**
 * A left click with no modifier: the only click an in-app handler may take
 * over. Cmd/Ctrl/Shift/Alt and the other buttons keep the anchor's own
 * behaviour, whatever the webview makes of it.
 */
export function isPlainLeftClick(event: React.MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** `#foo` (not `#/route`): a fragment inside this page, or null. */
function inPageFragment(href: string): string | null {
  if (!href.startsWith("#") || href.startsWith("#/") || href.length < 2) {
    return null;
  }
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}

/**
 * The anchor for links no richer kind (channel, message, entity) claimed.
 * Docs page links move the app to that page; fragments scroll within the
 * page; everything else is an external link opened outside the app.
 */
export function FallbackLinkAnchor(props: FallbackLinkAnchorProps) {
  const docsLink = props.href ? parseDocsPageLink(props.href) : null;
  if (docsLink?.ok) {
    return <DocsPageLinkAnchor {...props} pageId={docsLink.value.pageId} />;
  }
  const fragment = props.href ? inPageFragment(props.href) : null;
  if (fragment !== null) {
    return <FragmentLinkAnchor {...props} fragment={fragment} />;
  }
  return <ExternalLinkAnchor {...props} />;
}

/**
 * Only Docs links pay for the navigation hook: `useAppNavigation` subscribes
 * to the location, and every link in a message timeline goes through here.
 */
function DocsPageLinkAnchor({
  anchorProps,
  children,
  href,
  isLinearLink,
  label,
  pageId,
}: FallbackLinkAnchorProps & { pageId: string }) {
  const { goDocs } = useAppNavigation();
  const open = React.useCallback(() => {
    void goDocs(pageId);
  }, [goDocs, pageId]);
  const authoredOnClick = anchorProps.onClick;
  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      authoredOnClick?.(event);
      if (event.defaultPrevented || !isPlainLeftClick(event)) return;
      event.preventDefault();
      open();
    },
    [authoredOnClick, open],
  );
  return (
    <ExternalLinkAnchor
      anchorProps={{ ...anchorProps, onClick }}
      href={href}
      isLinearLink={isLinearLink}
      label={label}
      openLink={open}
    >
      {children}
    </ExternalLinkAnchor>
  );
}

function FragmentLinkAnchor({
  anchorProps,
  children,
  fragment,
  href,
}: FallbackLinkAnchorProps & { fragment: string }) {
  return (
    <a
      {...anchorProps}
      className="font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80"
      href={href}
      onClick={(event) => {
        anchorProps.onClick?.(event);
        if (event.defaultPrevented) return;
        // Hash history would read the fragment as a route change, so the
        // jump is made by hand and the URL is left alone.
        event.preventDefault();
        if (event.button !== 0) return;
        event.currentTarget.ownerDocument
          .getElementById(fragment)
          ?.scrollIntoView({ block: "start" });
      }}
    >
      {children}
    </a>
  );
}
