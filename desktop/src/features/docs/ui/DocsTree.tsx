import {
  ChevronDown,
  ChevronRight,
  FileText,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import * as React from "react";

import { deferMenuAction } from "@/features/sidebar/ui/sidebarMenuHelpers";
import { cn } from "@/shared/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

import type { DocPage } from "../lib/docPageCodec";
import {
  collectDescendantIds,
  type DocTreeNode,
  flattenDocTree,
} from "../lib/docTree";

export type DocsTreeProps = {
  /** Tombstoned pages, newest deletion first. */
  deletedPages: DocPage[];
  isLoading: boolean;
  onCreate: (parentId: string | null) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  onReorder: (id: string, direction: -1 | 1) => void;
  onRestore: (id: string) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
  tree: DocTreeNode[];
};

const RECENTLY_DELETED_LIMIT = 20;

export function docPageLabel(page: Pick<DocPage, "title">): string {
  return page.title.trim() || "Untitled";
}

/** Effective parent per page as the tree renders it (cycles already broken). */
function buildParentIndex(tree: DocTreeNode[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  const walk = (nodes: DocTreeNode[], parentId: string | null) => {
    for (const node of nodes) {
      index.set(node.page.id, parentId);
      walk(node.children, node.page.id);
    }
  };
  walk(tree, null);
  return index;
}

export function DocsTree({
  deletedPages,
  isLoading,
  onCreate,
  onDelete,
  onMove,
  onReorder,
  onRestore,
  onSelect,
  selectedId,
  tree,
}: DocsTreeProps) {
  const [collapsedIds, setCollapsedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingDelete, setPendingDelete] = React.useState<DocPage | null>(
    null,
  );
  const parentIndex = React.useMemo(() => buildParentIndex(tree), [tree]);
  const allNodes = React.useMemo(() => flattenDocTree(tree), [tree]);

  // Selecting a page (deep link, search, remote move) must never leave it
  // hidden inside a collapsed ancestor.
  // Only a *new* selection expands: a tree change caused by someone else's
  // edit must not undo what the user collapsed.
  const parentIndexRef = React.useRef(parentIndex);
  parentIndexRef.current = parentIndex;
  React.useEffect(() => {
    if (!selectedId) return;
    const parentIndex = parentIndexRef.current;
    setCollapsedIds((current) => {
      let next: Set<string> | null = null;
      let cursor = parentIndex.get(selectedId) ?? null;
      while (cursor) {
        if (current.has(cursor)) {
          next ??= new Set(current);
          next.delete(cursor);
        }
        cursor = parentIndex.get(cursor) ?? null;
      }
      return next ?? current;
    });
  }, [selectedId]);

  const toggleCollapsed = React.useCallback((id: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <nav
      aria-label="Pages"
      className="flex min-h-0 flex-1 flex-col"
      data-testid="docs-tree"
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pages
        </span>
        <Button
          aria-label="New page"
          data-testid="docs-new-page"
          onClick={() => onCreate(null)}
          size="icon-xs"
          title="New page"
          type="button"
          variant="ghost"
        >
          <Plus />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {isLoading && tree.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Loading pages…
          </p>
        ) : tree.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            <p>No pages yet.</p>
            <Button
              className="mt-2"
              onClick={() => onCreate(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus /> Create the first page
            </Button>
          </div>
        ) : (
          <ul className="space-y-px">
            {tree.map((node) => (
              <DocsTreeBranch
                allNodes={allNodes}
                collapsedIds={collapsedIds}
                key={node.page.id}
                node={node}
                onCreate={onCreate}
                onMove={onMove}
                onReorder={onReorder}
                onRequestDelete={setPendingDelete}
                onSelect={onSelect}
                onToggle={toggleCollapsed}
                selectedId={selectedId}
                tree={tree}
              />
            ))}
          </ul>
        )}
        {deletedPages.length > 0 ? (
          <RecentlyDeleted
            onRestore={onRestore}
            onSelect={onSelect}
            pages={deletedPages.slice(0, RECENTLY_DELETED_LIMIT)}
            selectedId={selectedId}
          />
        ) : null}
      </div>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDelete ? docPageLabel(pendingDelete) : ""}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The page is removed for everyone in the community. Pages nested
              inside it move to the top level.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}

function RecentlyDeleted({
  onRestore,
  onSelect,
  pages,
  selectedId,
}: {
  onRestore: (id: string) => void;
  onSelect: (id: string) => void;
  pages: DocPage[];
  selectedId: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <section className="mt-3 border-t border-border/60 pt-2">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
        data-testid="docs-recently-deleted-toggle"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Trash2 className="h-3.5 w-3.5" />
        Recently deleted ({pages.length})
      </button>
      {open ? (
        <ul className="mt-1 space-y-px">
          {pages.map((page) => {
            const label = docPageLabel(page);
            return (
              <li
                className={cn(
                  "group flex h-7 items-center gap-1 rounded-md pl-2 pr-0.5 text-sm text-muted-foreground",
                  selectedId === page.id && "bg-sidebar-accent",
                )}
                key={page.id}
              >
                <button
                  aria-current={selectedId === page.id ? "page" : undefined}
                  className="min-w-0 flex-1 truncate py-1 text-left line-through"
                  onClick={() => onSelect(page.id)}
                  type="button"
                >
                  {label}
                </button>
                <button
                  aria-label={`Restore ${label}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => onRestore(page.id)}
                  title="Restore"
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

type DocsTreeBranchProps = {
  allNodes: DocTreeNode[];
  collapsedIds: ReadonlySet<string>;
  node: DocTreeNode;
  onCreate: (parentId: string | null) => void;
  onMove: (id: string, parentId: string | null) => void;
  onReorder: (id: string, direction: -1 | 1) => void;
  onRequestDelete: (page: DocPage) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  selectedId: string | null;
  tree: DocTreeNode[];
};

function DocsTreeBranch({
  allNodes,
  collapsedIds,
  node,
  onCreate,
  onMove,
  onReorder,
  onRequestDelete,
  onSelect,
  onToggle,
  selectedId,
  tree,
}: DocsTreeBranchProps) {
  const { page } = node;
  const label = docPageLabel(page);
  const hasChildren = node.children.length > 0;
  const collapsed = collapsedIds.has(page.id);
  const selected = selectedId === page.id;

  return (
    <li>
      <div
        className={cn(
          "group flex h-7 items-center gap-0.5 rounded-md pr-0.5 text-sm",
          selected
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-foreground hover:bg-muted/60",
        )}
        data-testid={`docs-tree-row-${page.id}`}
        style={{ paddingLeft: `${node.depth * 0.75 + 0.25}rem` }}
      >
        {hasChildren ? (
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            onClick={() => onToggle(page.id)}
            type="button"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span aria-hidden="true" className="h-5 w-5 shrink-0" />
        )}
        <button
          aria-current={selected ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 text-left"
          onClick={() => onSelect(page.id)}
          type="button"
        >
          {page.icon ? (
            <span aria-hidden="true" className="w-4 shrink-0 text-center">
              {page.icon}
            </span>
          ) : (
            <FileText
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate">{label}</span>
        </button>
        <button
          aria-label={`New page inside ${label}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => onCreate(page.id)}
          title="New page inside"
          type="button"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <DocsTreeRowMenu
          allNodes={allNodes}
          node={node}
          onMove={onMove}
          onReorder={onReorder}
          onRequestDelete={onRequestDelete}
          tree={tree}
        />
      </div>
      {hasChildren && !collapsed ? (
        <ul className="space-y-px">
          {node.children.map((child) => (
            <DocsTreeBranch
              allNodes={allNodes}
              collapsedIds={collapsedIds}
              key={child.page.id}
              node={child}
              onCreate={onCreate}
              onMove={onMove}
              onReorder={onReorder}
              onRequestDelete={onRequestDelete}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedId={selectedId}
              tree={tree}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DocsTreeRowMenu({
  allNodes,
  node,
  onMove,
  onReorder,
  onRequestDelete,
  tree,
}: Pick<
  DocsTreeBranchProps,
  "allNodes" | "node" | "onMove" | "onReorder" | "onRequestDelete" | "tree"
>) {
  const { page } = node;
  const label = docPageLabel(page);
  const [open, setOpen] = React.useState(false);
  // Computed only while the menu is open: the candidate list walks the tree.
  const moveTargets = React.useMemo(() => {
    if (!open) return [];
    const excluded = collectDescendantIds(tree, page.id);
    excluded.add(page.id);
    return allNodes.filter((candidate) => !excluded.has(candidate.page.id));
  }, [allNodes, open, page.id, tree]);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Actions for ${label}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          type="button"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onSelect={() => onReorder(page.id, -1)}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onReorder(page.id, 1)}>
          Move down
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
            <DropdownMenuItem
              disabled={page.parentId === null}
              onSelect={() => onMove(page.id, null)}
            >
              Top level
            </DropdownMenuItem>
            {moveTargets.length > 0 ? <DropdownMenuSeparator /> : null}
            {moveTargets.map((candidate) => (
              <DropdownMenuItem
                disabled={candidate.page.id === page.parentId}
                key={candidate.page.id}
                onSelect={() => onMove(page.id, candidate.page.id)}
                style={{ paddingLeft: `${candidate.depth * 0.75 + 0.5}rem` }}
              >
                <span className="truncate">{docPageLabel(candidate.page)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => deferMenuAction(() => onRequestDelete(page))}
        >
          Delete page
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
