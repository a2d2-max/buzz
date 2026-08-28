import { PanelTop } from "lucide-react";

import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";

const OPS_REGIONS = [
  { id: "ops-session-tree", label: "Session tree" },
  { id: "ops-timeline", label: "Timeline" },
  { id: "ops-context", label: "Context" },
  { id: "ops-local-history-voice", label: "Local history / voice dock" },
] as const;

type OpsRegionProps = (typeof OPS_REGIONS)[number] & {
  className?: string;
};

function OpsRegion({ className = "", id, label }: OpsRegionProps) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={`flex min-h-36 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background ${className}`}
      data-testid={id}
      id={id}
    >
      <h2
        className="min-w-0 break-words border-border/60 border-b px-4 py-3 text-sm font-medium [overflow-wrap:anywhere]"
        id={`${id}-heading`}
      >
        {label}
      </h2>
      <div className="min-h-0 min-w-0 flex-1 break-words [overflow-wrap:anywhere]" />
    </section>
  );
}

export function OpsRoomScreen() {
  const focusRegion = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <TopChromeInsetHeader data-tauri-drag-region flush>
        <header className="flex min-h-14 min-w-0 items-center gap-3 px-5 py-2">
          <PanelTop className="h-5 w-5 shrink-0 text-muted-foreground" />
          <h1 className="min-w-0 break-words text-base font-semibold [overflow-wrap:anywhere]">
            Ops Room
          </h1>
        </header>
      </TopChromeInsetHeader>

      <main className="buzz-content-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-4">
        <nav
          aria-label="Ops Room regions"
          className="mb-3 grid min-w-0 grid-cols-2 gap-2 md:hidden"
        >
          {OPS_REGIONS.map((region) => (
            <button
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border/70 px-3 py-2 text-center text-sm font-medium hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              key={region.id}
              onClick={() => focusRegion(region.id)}
              type="button"
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {region.label}
              </span>
            </button>
          ))}
        </nav>

        <div className="grid min-w-0 gap-3 md:h-full md:min-h-[28rem] md:grid-cols-[minmax(12rem,0.85fr)_minmax(0,2fr)_minmax(12rem,1fr)] md:grid-rows-[minmax(0,1fr)_minmax(9rem,auto)]">
          <OpsRegion className="md:row-span-2 md:min-h-0" {...OPS_REGIONS[0]} />
          <OpsRegion className="md:min-h-0" {...OPS_REGIONS[1]} />
          <OpsRegion className="md:row-span-2 md:min-h-0" {...OPS_REGIONS[2]} />
          <OpsRegion className="md:min-h-0" {...OPS_REGIONS[3]} />
        </div>
      </main>
    </div>
  );
}
