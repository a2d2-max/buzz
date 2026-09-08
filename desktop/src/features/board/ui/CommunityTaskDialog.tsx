import * as React from "react";

import { COMMUNITY_TASK_TITLE_MAX_LENGTH } from "@/features/board/lib/communityTaskCodec";
import { dateInputValueToDue } from "@/features/board/lib/communityTaskDue";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export const COMMUNITY_TASK_FIELD_SHELL_CLASS =
  "rounded-xl border border-input bg-muted/40 transition-colors hover:border-muted-foreground/40 focus-within:border-muted-foreground/50";
export const COMMUNITY_TASK_FIELD_CONTROL_CLASS =
  "border-0 bg-transparent shadow-none outline-none ring-0 placeholder:text-muted-foreground/55 focus-visible:ring-0";

/** What the "New task" dialog hands back; status, order, and stamps are the panel's job. */
export type CommunityTaskDraft = {
  title: string;
  body: string;
  due?: number;
};

export function CommunityTaskDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: {
  isCreating: boolean;
  onCreate: (draft: CommunityTaskDraft) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [dueInput, setDueInput] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const submitInFlightRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setDueInput("");
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(
      () => titleInputRef.current?.focus(),
      50,
    );
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating || submitInFlightRef.current) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    submitInFlightRef.current = true;
    setErrorMessage(null);
    try {
      const due = dateInputValueToDue(dueInput);
      await onCreate({
        title: trimmedTitle,
        body: body.trim(),
        ...(due === undefined ? {} : { due }),
      });
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create the task.",
      );
    } finally {
      submitInFlightRef.current = false;
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="pt-3"
        data-testid="community-task-dialog"
        footer={
          <div className="flex w-full justify-end">
            <Button
              data-testid="community-task-dialog-submit"
              disabled={isCreating || title.trim().length === 0}
              form="community-task-form"
              type="submit"
            >
              {isCreating ? "Creating…" : "Create task"}
            </Button>
          </div>
        }
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        headerSubtitle="A card on this community's board, not tied to any repository."
        title="New task"
      >
        <form
          className="space-y-5"
          id="community-task-form"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="community-task-title"
            >
              Title
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                COMMUNITY_TASK_FIELD_SHELL_CLASS,
              )}
            >
              <Input
                className={cn("h-8 px-0", COMMUNITY_TASK_FIELD_CONTROL_CLASS)}
                data-testid="community-task-dialog-title"
                disabled={isCreating}
                id="community-task-title"
                maxLength={COMMUNITY_TASK_TITLE_MAX_LENGTH}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="What needs doing?"
                ref={titleInputRef}
                value={title}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="community-task-body"
            >
              Details
              <span className="ml-1 text-xs font-normal text-muted-foreground/50">
                Optional · Markdown
              </span>
            </label>
            <div className={COMMUNITY_TASK_FIELD_SHELL_CLASS}>
              <Textarea
                className={cn(
                  "min-h-28 resize-y px-3 py-3",
                  COMMUNITY_TASK_FIELD_CONTROL_CLASS,
                )}
                data-testid="community-task-dialog-body"
                disabled={isCreating}
                id="community-task-body"
                onChange={(event) => {
                  setBody(event.target.value);
                  setErrorMessage(null);
                }}
                placeholder="Context, links, acceptance criteria…"
                value={body}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="community-task-due"
            >
              Due
              <span className="ml-1 text-xs font-normal text-muted-foreground/50">
                Optional
              </span>
            </label>
            <div
              className={cn(
                "flex min-h-11 items-center px-3",
                COMMUNITY_TASK_FIELD_SHELL_CLASS,
              )}
            >
              <Input
                className={cn("h-8 px-0", COMMUNITY_TASK_FIELD_CONTROL_CLASS)}
                data-testid="community-task-dialog-due"
                disabled={isCreating}
                id="community-task-due"
                onChange={(event) => setDueInput(event.target.value)}
                type="date"
                value={dueInput}
              />
            </div>
          </div>
          {errorMessage ? (
            <p
              className="text-sm text-destructive"
              data-testid="community-task-dialog-error"
            >
              {errorMessage}
            </p>
          ) : null}
        </form>
      </ChooserDialogContent>
    </Dialog>
  );
}
