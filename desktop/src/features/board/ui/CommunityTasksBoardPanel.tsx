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
import {
  useCommunityTaskEventsQuery,
  useCommunityTasksLiveUpdates,
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
  const eventsQuery = useCommunityTaskEventsQuery();
  useCommunityTasksLiveUpdates();
  const identityQuery = useIdentityQuery();
  const viewer = identityQuery.data?.pubkey
    ? normalizePubkey(identityQuery.data.pubkey)
    : null;
  const { isPending: isSaving, mutateAsync: save } =
    useSaveCommunityTaskMutation();

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

  const handleMoveTask = React.useCallback(
    (task: CommunityTask, status: CommunityTaskStatus) => {
      setPendingStatus((current) => ({ ...current, [task.key]: status }));
      const content: CommunityTaskContent = {
        ...communityTaskContentOf(task),
        order: nextCommunityTaskOrder(),
        status,
        updatedAt: nextMonotonicSeconds(nowSeconds(), task.updatedAt),
      };
      void save({
        content,
        id: task.id,
        previousEventCreatedAt: latestOwnCommunityTaskEventCreatedAt(
          events,
          task.id,
          viewer ?? "",
        ),
      })
        .then(() => clearPendingStatus(task.key, status))
        .catch((error: unknown) => {
          // Roll the card back to the column it came from.
          clearPendingStatus(task.key, status);
          toast.error(
            error instanceof Error ? error.message : "Failed to move the task.",
          );
        });
    },
    [clearPendingStatus, events, save, viewer],
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
        order: nextCommunityTaskOrder(),
        createdAt: now,
        updatedAt: now,
      };
      if (draft.due !== undefined) content.due = draft.due;
      await save({ content, id: newCommunityTaskId() });
      toast.success("Task created.");
    },
    [save, viewer],
  );

  const handleSave = React.useCallback(
    async (content: CommunityTaskContent) => {
      if (!selectedTask) return;
      await save({
        content: {
          ...content,
          updatedAt: nextMonotonicSeconds(nowSeconds(), selectedTask.updatedAt),
        },
        id: selectedTask.id,
        previousEventCreatedAt: latestOwnCommunityTaskEventCreatedAt(
          events,
          selectedTask.id,
          viewer ?? "",
        ),
      });
      toast.success("Task saved.");
      setSelectedTaskKey(null);
    },
    [events, save, selectedTask, viewer],
  );

  const handleDelete = React.useCallback(async () => {
    if (!selectedTask) return;
    await save({
      content: tombstoneCommunityTaskContent(
        communityTaskContentOf(selectedTask),
        nowSeconds(),
      ),
      id: selectedTask.id,
      previousEventCreatedAt: latestOwnCommunityTaskEventCreatedAt(
        events,
        selectedTask.id,
        viewer ?? "",
      ),
    });
    toast.success("Task deleted.");
    setSelectedTaskKey(null);
  }, [events, save, selectedTask, viewer]);

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
  if (eventsQuery.isLoading) {
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
