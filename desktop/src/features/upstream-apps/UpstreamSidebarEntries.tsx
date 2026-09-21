import { useLocation, useNavigate } from "@tanstack/react-router";
import { BookOpen, KanbanSquare, RefreshCw } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/shared/ui/sidebar";
import { SidebarMenuLabel } from "@/shared/ui/sidebar-menu-label";
import { useUpstreamAppAvailability } from "./useUpstreamAppAvailability";
export function UpstreamSidebarEntries() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const availability = useUpstreamAppAvailability();
  if (availability.status === "loading") return null;
  if (availability.status === "error") {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          data-testid="retry-upstream-availability"
          onClick={availability.retry}
          tooltip="Check apps again"
          type="button"
        >
          <RefreshCw className="h-4 w-4" />
          <SidebarMenuLabel>Check apps again</SidebarMenuLabel>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return (
    <>
      {([...availability.products] as const).map((product) => {
        const title = product === "affine" ? "AFFiNE Docs" : "Plane Board";
        const testId =
          product === "affine" ? "open-docs-view" : "open-board-view";
        const Icon = product === "affine" ? BookOpen : KanbanSquare;
        return (
          <SidebarMenuItem key={product}>
            <SidebarMenuButton
              type="button"
              tooltip={title}
              isActive={pathname === `/apps/${product}`}
              onClick={() =>
                void navigate({ to: "/apps/$product", params: { product } })
              }
              data-testid={testId}
            >
              <Icon className="h-4 w-4" />
              <SidebarMenuLabel>{title}</SidebarMenuLabel>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
