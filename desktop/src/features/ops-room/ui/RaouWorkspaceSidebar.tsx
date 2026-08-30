import {
  Archive,
  BookOpen,
  Bot,
  Cable,
  FolderKanban,
  House,
  Route,
  ShieldCheck,
} from "lucide-react";

import { RAOU_PRODUCT } from "@/app/productBrand";
import { RaouMark } from "@/shared/ui/RaouMark";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import type { OpsRouteState, OpsView } from "../opsRouteState";

const WORKSPACE_ITEMS = [
  { icon: Bot, label: "Agent room", view: "room" },
  { icon: House, label: "Home", view: "home" },
  { icon: FolderKanban, label: "Work", view: "work" },
  { icon: Archive, label: "Artifacts", view: "artifacts" },
] as const;

const SOURCE_ITEMS = [
  { icon: BookOpen, label: "Knowledge", view: "knowledge" },
  { icon: Cable, label: "Connections", view: "connections" },
  { icon: Route, label: "Routing", view: "routing" },
  { icon: ShieldCheck, label: "Safety", view: "safety" },
] as const;

export const RAOU_WORKSPACE_VIEW_LABELS: Record<OpsView, string> = {
  artifacts: "Artifacts",
  connections: "Connections",
  home: "Home",
  knowledge: "Knowledge",
  room: "Agent room",
  routing: "Routing",
  safety: "Safety",
  work: "Work",
};

function WorkspaceMenu({
  items,
  onSelect,
  view,
}: {
  items: ReadonlyArray<{
    icon: typeof Bot;
    label: string;
    view: OpsView;
  }>;
  onSelect: (view: OpsView) => void;
  view: OpsView;
}) {
  return (
    <SidebarMenu>
      {items.map(({ icon: Icon, label, view: itemView }) => (
        <SidebarMenuItem key={itemView}>
          <SidebarMenuButton
            className="min-h-11 min-w-11 data-[active=true]:font-normal md:min-h-0 md:min-w-0"
            isActive={view === itemView}
            onClick={() => onSelect(itemView)}
            tooltip={label}
            type="button"
          >
            <Icon />
            <SidebarMenuLabel>{label}</SidebarMenuLabel>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function RaouWorkspaceSidebar({
  onSelect,
  state,
  workspaceId,
}: {
  onSelect: (view: OpsView) => void;
  state: OpsRouteState;
  workspaceId: string;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const selectView = (view: OpsView) => {
    onSelect(view);
    if (isMobile) {
      setOpenMobile(false);
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>("[data-sidebar='trigger']")
          ?.focus();
      });
    }
  };

  return (
    <Sidebar collapsible="icon">
      <nav
        aria-label="RAOU workspace"
        className="flex h-full min-h-0 flex-col"
        data-testid="raou-workspace-sidebar"
      >
        <SidebarHeader className="border-sidebar-border/60 border-b px-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar-accent/50">
              <RaouMark className="h-5 w-6 text-primary" />
            </span>
            <span className="grid min-w-0 group-data-[collapsible=icon]:hidden">
              <strong className="truncate text-sm tracking-[0.12em]">
                {RAOU_PRODUCT.name}
              </strong>
              <span className="truncate text-xs text-sidebar-foreground/55">
                {RAOU_PRODUCT.localWorkspaceLabel}
              </span>
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-0 py-2">
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <WorkspaceMenu
                items={WORKSPACE_ITEMS}
                onSelect={selectView}
                view={state.view}
              />
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Sources</SidebarGroupLabel>
            <SidebarGroupContent>
              <WorkspaceMenu
                items={SOURCE_ITEMS}
                onSelect={selectView}
                view={state.view}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-sidebar-border/60 border-t px-3 py-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-sidebar-foreground/55">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]"
            />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              Local · {workspaceId.slice(0, 8)}
            </span>
          </div>
        </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
