import * as React from "react";

import type { OpsView } from "../opsRouteState";
import type { OpsResponsiveLayout } from "../opsWindowSize";

const VIEWS: Array<{ id: OpsView; label: string }> = [
  { id: "home", label: "Home" },
  { id: "work", label: "Work" },
  { id: "artifacts", label: "Artifacts" },
  { id: "knowledge", label: "Knowledge" },
  { id: "connections", label: "Connections" },
  { id: "routing", label: "Routing" },
  { id: "safety", label: "Safety" },
  { id: "room", label: "Room" },
];
const TARGET = { minHeight: 44, minWidth: 44 } as const;

type Props = {
  layout: OpsResponsiveLayout;
  onOpenAgents?: () => void;
  onOpenProjects?: () => void;
  onOpenSettings?: () => void;
  onOpenWorkflows?: () => void;
  onSelect: (view: OpsView) => void;
  view: OpsView;
};

function NavLinks({ onSelect, view }: Omit<Props, "layout">) {
  return (
    <>
      {VIEWS.map((item) => (
        <button
          aria-current={view === item.id ? "page" : undefined}
          className="min-h-11 shrink-0 rounded-lg px-3 text-left text-sm hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-primary/10"
          data-ops-interactive
          key={item.id}
          onClick={() => onSelect(item.id)}
          style={TARGET}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </>
  );
}

function NativeLinks({
  onOpenAgents,
  onOpenProjects,
  onOpenSettings,
  onOpenWorkflows,
}: Pick<
  Props,
  "onOpenAgents" | "onOpenProjects" | "onOpenSettings" | "onOpenWorkflows"
>) {
  const links: Array<{ label: string; open?: () => void }> = [
    { label: "Agents", open: onOpenAgents },
    { label: "Projects", open: onOpenProjects },
    { label: "Workflows", open: onOpenWorkflows },
    { label: "Settings", open: onOpenSettings },
  ];
  return (
    <>
      {links.map(({ label, open }) => (
        <button
          className="min-h-11 shrink-0 rounded-lg px-3 text-left text-sm hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          data-ops-interactive
          disabled={!open}
          key={label}
          onClick={open}
          style={TARGET}
          title={open ? undefined : "Restore identity to open this Buzz screen"}
          type="button"
        >
          {label}
        </button>
      ))}
    </>
  );
}

export function OpsSecondaryNav({
  layout,
  onOpenAgents,
  onOpenProjects,
  onOpenSettings,
  onOpenWorkflows,
  onSelect,
  view,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const closing = React.useRef(false);
  const close = React.useCallback(() => {
    closing.current = true;
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    dialog.current?.focus({ preventScroll: true });
    let recapturing = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const nodes = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled])",
        ) ?? [],
      );
      const first = nodes[0],
        last = nodes.at(-1);
      if (!first || !last) return;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    const recapture = (event: FocusEvent) => {
      if (
        closing.current ||
        recapturing ||
        dialog.current?.contains(event.target as Node)
      )
        return;
      recapturing = true;
      dialog.current?.focus({ preventScroll: true });
      recapturing = false;
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("focusin", recapture);
    return () => {
      closing.current = false;
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("focusin", recapture);
    };
  }, [close, open]);
  if (layout === "desktop")
    return (
      <nav
        aria-label="Ops sections"
        className="flex h-full w-44 shrink-0 flex-col gap-1 border-border/60 border-r p-2"
      >
        <p className="px-3 py-2 text-xs font-semibold text-muted-foreground">
          Sections
        </p>
        <NavLinks onSelect={onSelect} view={view} />
        <p className="mt-2 border-border/60 border-t px-3 pt-3 text-xs font-semibold text-muted-foreground">
          Buzz
        </p>
        <NativeLinks
          onOpenAgents={onOpenAgents}
          onOpenProjects={onOpenProjects}
          onOpenSettings={onOpenSettings}
          onOpenWorkflows={onOpenWorkflows}
        />
      </nav>
    );
  if (layout === "compact")
    return (
      <nav
        aria-label="Ops sections"
        className="flex min-w-0 gap-1 overflow-x-auto border-border/60 border-b p-2"
      >
        <NavLinks onSelect={onSelect} view={view} />
        <NativeLinks
          onOpenAgents={onOpenAgents}
          onOpenProjects={onOpenProjects}
          onOpenSettings={onOpenSettings}
          onOpenWorkflows={onOpenWorkflows}
        />
      </nav>
    );
  return (
    <>
      <div className="border-border/60 border-b p-2">
        <button
          aria-expanded={open}
          className="min-h-11 rounded-lg border border-border px-3 text-sm font-medium"
          data-ops-interactive
          onClick={() => setOpen(true)}
          ref={trigger}
          style={TARGET}
          type="button"
        >
          Sections
        </button>
      </div>
      {open ? (
        <div className="fixed inset-0 z-[80] flex items-end bg-background/70 p-2 sm:items-center sm:justify-center">
          <div
            aria-label="Sections"
            aria-modal="true"
            className="max-h-[min(32rem,90dvh)] w-full overflow-auto rounded-xl border border-border bg-background p-3 shadow-2xl sm:max-w-md"
            ref={dialog}
            role="dialog"
            tabIndex={-1}
          >
            <h2 className="mb-2 text-base font-semibold">Sections</h2>
            <div className="grid gap-1">
              <NavLinks
                onSelect={(next) => {
                  onSelect(next);
                  close();
                }}
                view={view}
              />
              <NativeLinks
                onOpenAgents={onOpenAgents}
                onOpenProjects={onOpenProjects}
                onOpenSettings={onOpenSettings}
                onOpenWorkflows={onOpenWorkflows}
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
