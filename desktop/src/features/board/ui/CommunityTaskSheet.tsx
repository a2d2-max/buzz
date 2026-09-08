import { Trash2 } from "lucide-react";
import * as React from "react";

import {
  COMMUNITY_TASK_TITLE_MAX_LENGTH,
  type CommunityTaskContent,
  type CommunityTaskStatus,
  isCommunityTaskStatus,
} from "@/features/board/lib/communityTaskCodec";
import {
  COMMUNITY_TASK_COLUMN_ORDER,
  COMMUNITY_TASK_STATUS_LABELS,
} from "@/features/board/lib/communityTaskColumns";
import {
  dateInputValueToDue,
  dueToDateInputValue,
} from "@/features/board/lib/communityTaskDue";
import {
  type CommunityTask,
  communityTaskContentOf,
} from "@/features/board/lib/communityTaskMerge";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cn } from "@/shared/lib/cn";
import { formatItemTimestamp } from "@/shared/lib/datetime";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Markdown } from "@/shared/ui/markdown";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Textarea } from "@/shared/ui/textarea";
import { CommunityTaskAssigneePicker } from "./CommunityTaskAssigneePicker";
import {
  CommunityTaskAvatar,
  communityTaskProfileLabel,
} from "./CommunityTaskAssignees";
import {
  COMMUNITY_TASK_FIELD_CONTROL_CLASS,
  COMMUNITY_TASK_FIELD_SHELL_CLASS,
} from "./CommunityTaskDialog";
import { CommunityTaskDueChip } from "./CommunityTasksBoard";

type Draft = {
  assignees: string[];
  body: string;
  dueInput: string;
  status: CommunityTaskStatus;
  title: string;
};

function draftOf(task: CommunityTask): Draft {
  return {
    assignees: task.assignees,
    body: task.body,
    dueInput: dueToDateInputValue(task.due),
    status: task.status,
    title: task.title,
  };
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      className="block text-xs font-medium text-muted-foreground"
      htmlFor={htmlFor}
    >
      {children}
    </label>
  );
}

/**
 * Side sheet for one card. Editors (author or assignee) get the form and
 * Save; the author also gets Delete; everyone else reads the card as it is.
 * The draft is reset when a different card opens, not on every live update,
 * so an edit in progress is never clobbered by someone else's revision.
 */
export function CommunityTaskSheet({
  canDelete,
  canEdit,
  isSaving,
  onDelete,
  onOpenChange,
  onSave,
  open,
  profiles,
  task,
  viewerPubkey,
}: {
  canDelete: boolean;
  canEdit: boolean;
  isSaving: boolean;
  onDelete: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onSave: (content: CommunityTaskContent) => Promise<void>;
  open: boolean;
  profiles?: UserProfileLookup;
  task: CommunityTask | null;
  viewerPubkey: string | null;
}) {
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const inFlightRef = React.useRef(false);
  const taskKey = task?.key ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when a different card opens, never on a live revision of the same card
  React.useEffect(() => {
    setDraft(task ? draftOf(task) : null);
    setConfirmingDelete(false);
    setErrorMessage(null);
  }, [open, taskKey]);

  const patch = (changes: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
    setErrorMessage(null);
  };

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task || !draft || isSaving || inFlightRef.current) return;
    const title = draft.title.trim();
    if (!title) {
      setErrorMessage("Give the task a title.");
      return;
    }
    inFlightRef.current = true;
    try {
      const due = dateInputValueToDue(draft.dueInput);
      const content: CommunityTaskContent = {
        ...communityTaskContentOf(task),
        assignees: draft.assignees,
        body: draft.body.trim(),
        status: draft.status,
        title,
      };
      if (due === undefined) delete content.due;
      else content.due = due;
      await onSave(content);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to save the task.",
      );
    } finally {
      inFlightRef.current = false;
    }
  }

  async function handleDelete() {
    if (!task || isSaving || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await onDelete();
    } catch (error) {
      setConfirmingDelete(false);
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to delete the task.",
      );
    } finally {
      inFlightRef.current = false;
    }
  }

  const busy = isSaving;

  return (
    <Sheet
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <SheetContent
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md"
        data-testid="community-task-sheet"
        side="right"
      >
        {task && draft ? (
          <>
            <SheetHeader className="border-b border-border/60 px-5 py-4 pr-12 text-left">
              <SheetTitle className="text-base">
                {canEdit ? "Edit task" : "Task"}
              </SheetTitle>
              <SheetDescription className="flex items-center gap-1.5 text-xs">
                <CommunityTaskAvatar profiles={profiles} pubkey={task.author} />
                <span>
                  {communityTaskProfileLabel(task.author, profiles)} ·{" "}
                  {formatItemTimestamp(task.createdAt)}
                </span>
              </SheetDescription>
            </SheetHeader>
            {canEdit ? (
              <form
                className="flex flex-1 flex-col gap-4 px-5 py-4"
                data-testid="community-task-form"
                onSubmit={(event) => void handleSubmit(event)}
              >
                <div className="space-y-1.5">
                  <FieldLabel htmlFor="community-task-sheet-title">
                    Title
                  </FieldLabel>
                  <div
                    className={cn(
                      "flex min-h-10 items-center px-3",
                      COMMUNITY_TASK_FIELD_SHELL_CLASS,
                    )}
                  >
                    <Input
                      className={cn(
                        "h-8 px-0",
                        COMMUNITY_TASK_FIELD_CONTROL_CLASS,
                      )}
                      data-testid="community-task-sheet-title"
                      disabled={busy}
                      id="community-task-sheet-title"
                      maxLength={COMMUNITY_TASK_TITLE_MAX_LENGTH}
                      onChange={(event) => patch({ title: event.target.value })}
                      value={draft.title}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="community-task-sheet-status">
                      Status
                    </FieldLabel>
                    <div className={COMMUNITY_TASK_FIELD_SHELL_CLASS}>
                      <select
                        className={cn(
                          "h-10 w-full px-3 text-sm",
                          COMMUNITY_TASK_FIELD_CONTROL_CLASS,
                        )}
                        data-testid="community-task-sheet-status"
                        disabled={busy}
                        id="community-task-sheet-status"
                        onChange={(event) => {
                          const next = event.target.value;
                          if (isCommunityTaskStatus(next))
                            patch({ status: next });
                        }}
                        value={draft.status}
                      >
                        {COMMUNITY_TASK_COLUMN_ORDER.map((status) => (
                          <option key={status} value={status}>
                            {COMMUNITY_TASK_STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel htmlFor="community-task-sheet-due">
                      Due
                    </FieldLabel>
                    <div
                      className={cn(
                        "flex min-h-10 items-center px-3",
                        COMMUNITY_TASK_FIELD_SHELL_CLASS,
                      )}
                    >
                      <Input
                        className={cn(
                          "h-8 px-0",
                          COMMUNITY_TASK_FIELD_CONTROL_CLASS,
                        )}
                        data-testid="community-task-sheet-due"
                        disabled={busy}
                        id="community-task-sheet-due"
                        onChange={(event) =>
                          patch({ dueInput: event.target.value })
                        }
                        type="date"
                        value={draft.dueInput}
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <FieldLabel htmlFor="community-task-sheet-body">
                    Details
                    <span className="ml-1 font-normal text-muted-foreground/50">
                      Markdown
                    </span>
                  </FieldLabel>
                  <div className={COMMUNITY_TASK_FIELD_SHELL_CLASS}>
                    <Textarea
                      className={cn(
                        "min-h-32 resize-y px-3 py-3",
                        COMMUNITY_TASK_FIELD_CONTROL_CLASS,
                      )}
                      data-testid="community-task-sheet-body"
                      disabled={busy}
                      id="community-task-sheet-body"
                      onChange={(event) => patch({ body: event.target.value })}
                      value={draft.body}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <FieldLabel>Assignees</FieldLabel>
                  <CommunityTaskAssigneePicker
                    assignees={draft.assignees}
                    disabled={busy}
                    onChange={(assignees) => patch({ assignees })}
                    profiles={profiles}
                    viewerPubkey={viewerPubkey}
                  />
                </div>
                {errorMessage ? (
                  <p
                    className="text-sm text-destructive"
                    data-testid="community-task-sheet-error"
                  >
                    {errorMessage}
                  </p>
                ) : null}
                <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                  {canDelete ? (
                    confirmingDelete ? (
                      <span className="flex items-center gap-1.5">
                        <Button
                          data-testid="community-task-sheet-delete-confirm"
                          disabled={busy}
                          onClick={() => void handleDelete()}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          Delete for everyone
                        </Button>
                        <Button
                          data-testid="community-task-sheet-delete-cancel"
                          disabled={busy}
                          onClick={() => setConfirmingDelete(false)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Keep
                        </Button>
                      </span>
                    ) : (
                      <Button
                        className="text-destructive hover:text-destructive"
                        data-testid="community-task-sheet-delete"
                        disabled={busy}
                        onClick={() => setConfirmingDelete(true)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden="true" />
                        Delete
                      </Button>
                    )
                  ) : (
                    <span />
                  )}
                  <Button
                    data-testid="community-task-sheet-save"
                    disabled={busy || draft.title.trim().length === 0}
                    size="sm"
                    type="submit"
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                </div>
              </form>
            ) : (
              <div
                className="flex flex-1 flex-col gap-4 px-5 py-4"
                data-testid="community-task-readonly"
              >
                <h2 className="text-base font-medium text-foreground">
                  {task.title.trim() || "Untitled task"}
                </h2>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span data-testid="community-task-readonly-status">
                    {COMMUNITY_TASK_STATUS_LABELS[task.status]}
                  </span>
                  {task.due !== undefined ? (
                    <CommunityTaskDueChip due={task.due} status={task.status} />
                  ) : null}
                </div>
                {task.body.trim() ? (
                  <Markdown className="text-sm" content={task.body} />
                ) : (
                  <p className="text-sm text-muted-foreground/70">
                    No details.
                  </p>
                )}
                <div className="space-y-1.5">
                  <FieldLabel>Assignees</FieldLabel>
                  <CommunityTaskAssigneePicker
                    assignees={task.assignees}
                    disabled
                    onChange={() => {}}
                    profiles={profiles}
                    viewerPubkey={viewerPubkey}
                  />
                </div>
                <p className="text-xs text-muted-foreground/60">
                  Only the author and assignees can change this task.
                </p>
              </div>
            )}
          </>
        ) : (
          <SheetHeader className="px-5 py-4 text-left">
            <SheetTitle className="text-base">Task</SheetTitle>
            <SheetDescription>
              This task is no longer on the board.
            </SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}
