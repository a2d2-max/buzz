import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  type CommunityTaskContent,
  type CommunityTaskStatus,
  newCommunityTaskId,
  nextMonotonicSeconds,
  tombstoneCommunityTaskContent,
} from "@/features/board/lib/communityTaskCodec";
import { nextCommunityTaskOrder } from "@/features/board/lib/communityTaskColumns";
import {
  type CommunityTask,
  canDeleteCommunityTask,
  canEditCommunityTask,
  communityTaskContentOf,
  latestOwnCommunityTaskEventCreatedAt,
  mergeCommunityTaskEvents,
} from "@/features/board/lib/communityTaskMerge";
import { CommunityTaskWriteQueue } from "@/features/board/lib/communityTaskWriteQueue";
import {
  useCommunityTasks,
  useSaveCommunityTaskMutation,
} from "@/features/board/lib/useCommunityTasks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { ProjectPanelState } from "@/features/projects/ui/ProjectPanelState";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { RelayEvent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";
import {
  CommunityTaskDialog,
  type CommunityTaskDraft,
} from "./CommunityTaskDialog";
import { CommunityTaskSheet } from "./CommunityTaskSheet";
import { CommunityTasksBoard } from "./CommunityTasksBoard";

const EMPTY_EVENTS: RelayEvent[] = [];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** The `order` that puts `key` at the bottom of `status` on `board`. */
function orderAtBottom(
  board: readonly CommunityTask[],
  status: CommunityTaskStatus,
  key: string,
): number {
  return nextCommunityTaskOrder(
    board.filter((task) => task.status === status && task.key !== key),
  );
}

export type CommunityTasksBoardPanelProps = {
  className?: string;
};

/**
 * Board › Tasks: free-form kanban cards for the whole community, not tied
 * to any repository. Self-contained — drop it into the Tasks tab as
 * `<CommunityTasksBoardPanel />`. Data lives in kind:30078 events on the
 * active relay (see `communityTaskCodec.ts`); `CommunityTasksBoard` stays
 * presentational so it renders in tests without a relay.
 */
export function CommunityTasksBoardPanel({
  className,
}: CommunityTasksBoardPanelProps = {}) {
  const queryClient = useQueryClient();
  const { query: eventsQuery, queryKey } = useCommunityTasks();
  const identityQuery = useIdentityQuery();
  const viewer = identityQuery.data?.pubkey
    ? normalizePubkey(identityQuery.data.pubkey)
    : null;
  const { isPending: isSaving, mutateAsync: save } =
    useSaveCommunityTaskMutation();
  const writeQueue = React.useRef(new CommunityTaskWriteQueue()).current;

  const events = eventsQuery.data ?? EMPTY_EVENTS;
  const tasks = React.useMemo(() => mergeCommunityTaskEvents(events), [events]);

  // Show the move immediately, then drop the overlay once the write settles
  // (success folds the signed event into the cache first; failure rolls
  // back). It never outlives one write, so a lagging relay cannot strand a
  // card in a column it isn't in.
  const [pendingStatus, setPendingStatus] = React.useState<
    Record<string, CommunityTaskStatus>
  >({});
  const clearPendingStatus = React.useCallback(
    (taskKey: string, status: CommunityTaskStatus) => {
      setPendingStatus((current) => {
        // A newer drag on the same card owns the overlay now.
        if (current[taskKey] !== status) return current;
        const rest = { ...current };
        delete rest[taskKey];
        return rest;
      });
    },
    [],
  );
  const visibleTasks = React.useMemo(
    () =>
      tasks.map((task) => {
        const pending = pendingStatus[task.key];
        return pending ? { ...task, status: pending } : task;
      }),
    [pendingStatus, tasks],
  );

  const peoplePubkeys = React.useMemo(() => {
    const pubkeys = new Set<string>();
    for (const task of tasks) {
      pubkeys.add(task.author);
      for (const assignee of task.assignees) pubkeys.add(assignee);
    }
    return [...pubkeys];
  }, [tasks]);
  const profiles = useUsersBatchQuery(peoplePubkeys, {
    enabled: peoplePubkeys.length > 0,
  }).data?.profiles;

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selectedTaskKey, setSelectedTaskKey] = React.useState<string | null>(
    null,
  );
  const selectedTask =
    visibleTasks.find((task) => task.key === selectedTaskKey) ?? null;

  const canMoveTask = React.useCallback(
    (task: CommunityTask) => canEditCommunityTask(task, viewer),
    [viewer],
  );

  /**
   * The board as the cache knows it right now — not this render's snapshot
   * — so a queued write builds on whatever the write before it left behind.
   */
  const readFreshBoard = React.useCallback(
    () =>
      mergeCommunityTaskEvents(
        queryClient.getQueryData<RelayEvent[]>(queryKey) ?? EMPTY_EVENTS,
      ),
    [queryClient, queryKey],
  );

  /**
   * One write to one card, queued behind any write already in flight for
   * it. `build` gets the card's freshest state (and the fresh board, for
   * column order) and returns the content to publish; the stamps are set
   * here, from that fresh state, so every write strictly follows the one
   * before it instead of tying with it on a same-second clock.
   */
  const writeCard = React.useCallback(
    (
      key: string,
      build: (
        fresh: CommunityTask,
        board: readonly CommunityTask[],
      ) => CommunityTaskContent,
    ) =>
      writeQueue.enqueue(key, async () => {
        const board = readFreshBoard();
        const fresh = board.find((task) => task.key === key);
        if (!fresh) throw new Error("This task is no longer on the board.");
        const content = build(fresh, board);
        const cached =
          queryClient.getQueryData<RelayEvent[]>(queryKey) ?? EMPTY_EVENTS;
        await save({
          content: {
            ...content,
            updatedAt: nextMonotonicSeconds(nowSeconds(), fresh.updatedAt),
          },
          id: fresh.id,
          previousEventCreatedAt: viewer
            ? latestOwnCommunityTaskEventCreatedAt(cached, fresh.id, viewer)
            : undefined,
        });
      }),
    [queryClient, queryKey, readFreshBoard, save, viewer, writeQueue],
  );

  const handleMoveTask = React.useCallback(
    (task: CommunityTask, status: CommunityTaskStatus) => {
      setPendingStatus((current) => ({ ...current, [task.key]: status }));
      void writeCard(task.key, (fresh, board) => ({
        ...communityTaskContentOf(fresh),
        order: orderAtBottom(board, status, fresh.key),
        status,
      }))
        .then(() => clearPendingStatus(task.key, status))
        .catch((error: unknown) => {
          // Roll the card back to the column it came from.
          clearPendingStatus(task.key, status);
          toast.error(
            error instanceof Error ? error.message : "Failed to move the task.",
          );
        });
    },
    [clearPendingStatus, writeCard],
  );

  const handleCreate = React.useCallback(
    async (draft: CommunityTaskDraft) => {
      if (!viewer) throw new Error("Sign in to create tasks.");
      const now = nowSeconds();
      const content: CommunityTaskContent = {
        author: viewer,
        title: draft.title,
        body: draft.body,
        status: "todo",
        assignees: [],
        order: nextCommunityTaskOrder(
          readFreshBoard().filter((task) => task.status === "todo"),
        ),
        createdAt: now,
        updatedAt: now,
      };
      if (draft.due !== undefined) content.due = draft.due;
      await save({ content, id: newCommunityTaskId() });
      toast.success("Task created.");
    },
    [readFreshBoard, save, viewer],
  );

  const handleSave = React.useCallback(
    async (content: CommunityTaskContent) => {
      if (!selectedTask) return;
      await writeCard(selectedTask.key, (fresh, board) => {
        // The sheet's draft owns the fields a person edits; identity and
        // position come from the card as it is now.
        const next: CommunityTaskContent = {
          ...communityTaskContentOf(fresh),
          assignees: content.assignees,
          body: content.body,
          status: content.status,
          title: content.title,
        };
        if (content.due === undefined) delete next.due;
        else next.due = content.due;
        if (content.status !== fresh.status) {
          next.order = orderAtBottom(board, content.status, fresh.key);
        }
        return next;
      });
      toast.success("Task saved.");
      setSelectedTaskKey(null);
    },
    [selectedTask, writeCard],
  );

  const handleDelete = React.useCallback(async () => {
    if (!selectedTask) return;
    await writeCard(selectedTask.key, (fresh) =>
      tombstoneCommunityTaskContent(
        communityTaskContentOf(fresh),
        nowSeconds(),
      ),
    );
    toast.success("Task deleted.");
    setSelectedTaskKey(null);
  }, [selectedTask, writeCard]);

  const handleOpenTask = React.useCallback(
    (task: CommunityTask) => setSelectedTaskKey(task.key),
    [],
  );

  const newTaskButton = (
    <Button
      data-testid="community-task-new"
      disabled={!viewer}
      onClick={() => setDialogOpen(true)}
      size="sm"
      title={viewer ? undefined : "Sign in to create tasks."}
      type="button"
    >
      <Plus aria-hidden="true" />
      New task
    </Button>
  );

  let body: React.ReactNode;
  if (eventsQuery.isPending) {
    // Also covers the moment before the live subscription is armed and
    // history is allowed to start.
    body = <BuzzLoadingState label="Loading tasks" />;
  } else if (visibleTasks.length === 0) {
    body = (
      <ProjectPanelState
        action={eventsQuery.error ? undefined : newTaskButton}
        description={
          eventsQuery.error
            ? "Check the relay connection and try again."
            : "Tasks anyone here creates will show up on this board."
        }
        error={Boolean(eventsQuery.error)}
        panel={false}
        testId="community-tasks-empty"
        title={eventsQuery.error ? "Could not load tasks" : "No tasks yet"}
      />
    );
  } else {
    body = (
      <>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {visibleTasks.length === 1
              ? "1 task"
              : `${visibleTasks.length} tasks`}
          </p>
          {newTaskButton}
        </div>
        <CommunityTasksBoard
          canMoveTask={canMoveTask}
          onMoveTask={handleMoveTask}
          onOpenTask={handleOpenTask}
          profiles={profiles}
          tasks={visibleTasks}
        />
      </>
    );
  }

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-testid="community-tasks-board-panel"
    >
      {body}
      <CommunityTaskDialog
        isCreating={isSaving}
        onCreate={handleCreate}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
      <CommunityTaskSheet
        canDelete={
          selectedTask ? canDeleteCommunityTask(selectedTask, viewer) : false
        }
        canEdit={
          selectedTask ? canEditCommunityTask(selectedTask, viewer) : false
        }
        isSaving={isSaving}
        onDelete={handleDelete}
        onOpenChange={(open) => {
          if (!open) setSelectedTaskKey(null);
        }}
        onSave={handleSave}
        open={selectedTaskKey !== null}
        profiles={profiles}
        task={selectedTask}
        viewerPubkey={viewer}
      />
    </div>
  );
}

export default CommunityTasksBoardPanel;
