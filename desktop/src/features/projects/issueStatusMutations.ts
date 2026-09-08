import { useMutation } from "@tanstack/react-query";

import { signProjectIssueStatus } from "@/shared/api/projectGit";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import {
  issueBoardDropTarget,
  type IssueBoardDropStatus,
  type ProjectIssueStatusWord,
} from "./lib/issueBoardColumns";
import type { Repository as Project } from "./hooks";
import { useProjectIssueWriteInvalidator } from "./issueAssignments";
import {
  nextProjectIssueStatusCreatedAt,
  type ProjectIssue,
} from "./projectIssues.mjs";

export type ProjectIssueStatusMutationInput = {
  /**
   * `created_at` for the status event. A board that already shows the move
   * optimistically passes the timestamp it displayed, so the published event
   * and the overlay agree exactly and a second drop on the same card (whose
   * overlaid `statusCreatedAt` is this value) always outranks the first.
   * Defaults to the next second after the issue's current status.
   */
  createdAt?: number;
  issue: ProjectIssue;
  /**
   * Repository the status event is published against. Optional for the
   * per-project board, which binds one project to the whole hook; the
   * community board carries cards from many repositories, so it names the
   * target per drop instead.
   */
  project?: Project;
  signAsManagedOwner: boolean;
  status: IssueBoardDropStatus;
};

/**
 * The status event a board drop publishes: root `e` tag, repo `a` tag, and
 * `p` tags for the repo owner and the task author (only those two are trusted
 * for status changes — `allowedActorsForRoot` in projectIssues.mjs).
 *
 * This is the tag set the desktop *sends*. The signer's own `p` tag is
 * dropped downstream by nostr's `EventBuilder`, so the event on the relay
 * carries only the counterparty, and the managed-owner path builds its tags
 * natively in Rust — so the two paths agree on meaning, not byte-for-byte on
 * tag order.
 */
export function projectIssueStatusEvent(
  project: Project,
  issue: ProjectIssue,
  status: IssueBoardDropStatus,
  now: number,
  createdAt?: number,
): {
  createdAt: number;
  kind: number;
  tags: string[][];
  word: ProjectIssueStatusWord;
} {
  const target = issueBoardDropTarget(status);
  if (target === null) {
    throw new Error("That column cannot be published as a task status.");
  }
  const recipients = [
    ...new Set([project.owner.toLowerCase(), issue.author.toLowerCase()]),
  ];
  return {
    createdAt: createdAt ?? nextProjectIssueStatusCreatedAt(issue, now),
    kind: target.kind,
    word: target.word,
    tags: [
      ["e", issue.id, "", "root"],
      ["a", project.repoAddress],
      ...recipients.map((recipient) => ["p", recipient]),
    ],
  };
}

export async function updateProjectIssueStatus({
  createdAt: requestedCreatedAt,
  issue,
  project,
  signAsManagedOwner,
  status,
}: ProjectIssueStatusMutationInput & { project: Project }): Promise<void> {
  const { createdAt, kind, tags, word } = projectIssueStatusEvent(
    project,
    issue,
    status,
    Math.floor(Date.now() / 1_000),
    requestedCreatedAt,
  );
  if (signAsManagedOwner) {
    await signProjectIssueStatus({
      targetOwner: project.owner,
      repoAddress: project.repoAddress,
      issueId: issue.id,
      issueAuthor: issue.author,
      status: word,
      createdAt,
    });
    return;
  }
  const event = await signRelayEvent({ kind, content: "", createdAt, tags });

  await relayClient.publishEvent(
    event,
    "Timed out updating task status.",
    "Failed to update task status.",
  );
}

/**
 * Publishes a board drop as a NIP-34 status event. `project` may be bound here
 * (per-project board) or supplied per mutate call (community board); the call
 * variable wins so one hook can write to any repository the viewer may move.
 */
export function useUpdateProjectIssueStatusMutation(project?: Project | null) {
  const invalidate = useProjectIssueWriteInvalidator();

  return useMutation({
    mutationFn: (input: ProjectIssueStatusMutationInput) => {
      const target = input.project ?? project;
      if (!target) throw new Error("No project selected.");
      return updateProjectIssueStatus({ ...input, project: target });
    },
    onSuccess: (_result, input) => invalidate((input.project ?? project)?.id),
  });
}
