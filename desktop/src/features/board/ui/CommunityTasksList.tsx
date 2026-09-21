import type { CommunityTask } from "@/features/board/lib/communityTaskMerge";
import { COMMUNITY_TASK_STATUS_LABELS } from "@/features/board/lib/communityTaskColumns";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { CommunityTaskAssigneeFacepile } from "./CommunityTaskAssignees";
import { CommunityTaskDueChip } from "./CommunityTasksBoard";

/** A second view of the same cards; opening a row uses the existing permission-aware sheet. */
export function CommunityTasksList({
  tasks,
  profiles,
  onOpenTask,
}: {
  tasks: CommunityTask[];
  profiles?: UserProfileLookup;
  onOpenTask: (task: CommunityTask) => void;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-auto px-4 pb-4"
      data-testid="community-tasks-list"
    >
      <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
        <caption className="sr-only">Tasks</caption>
        <thead className="sticky top-0 bg-background text-muted-foreground">
          <tr className="border-b border-border/60">
            <th className="px-3 py-2 font-medium" scope="col">
              Task
            </th>
            <th className="w-28 px-3 py-2 font-medium" scope="col">
              Status
            </th>
            <th className="w-32 px-3 py-2 font-medium" scope="col">
              Assignees
            </th>
            <th className="w-32 px-3 py-2 font-medium" scope="col">
              Due date
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              className="border-b border-border/40 hover:bg-muted/30"
              key={task.key}
              data-task-id={task.id}
              data-testid="community-task-row"
            >
              <td className="max-w-md px-3 py-2">
                <button
                  type="button"
                  aria-label={`Open ${task.title.trim() || "Untitled task"}`}
                  className="w-full truncate rounded py-1 text-left font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenTask(task)}
                >
                  {task.title.trim() || "Untitled task"}
                </button>
              </td>
              <td className="px-3 py-2">
                {COMMUNITY_TASK_STATUS_LABELS[task.status]}
              </td>
              <td className="px-3 py-2">
                {task.assignees.length ? (
                  <CommunityTaskAssigneeFacepile
                    assignees={task.assignees}
                    profiles={profiles}
                  />
                ) : (
                  <span className="text-muted-foreground">Unassigned</span>
                )}
              </td>
              <td className="px-3 py-2">
                {task.due === undefined ? (
                  <span className="text-muted-foreground">No due date</span>
                ) : (
                  <CommunityTaskDueChip due={task.due} status={task.status} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
