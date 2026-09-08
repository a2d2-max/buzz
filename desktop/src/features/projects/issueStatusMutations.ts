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
import { useProjectIssueWriteInvalidation } from "./issueAssignments";
import {
  nextProjectIssueStatusCreatedAt,
  type ProjectIssue,
} from "./projectIssues.mjs";

export type ProjectIssueStatusMutationInput = {
  issue: ProjectIssue;
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
    createdAt: nextProjectIssueStatusCreatedAt(issue, now),
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

export function useUpdateProjectIssueStatusMutation(
  project: Project | null | undefined,
) {
  const invalidate = useProjectIssueWriteInvalidation(project);

  return useMutation({
    mutationFn: (input: ProjectIssueStatusMutationInput) => {
      if (!project) throw new Error("No project selected.");
      return updateProjectIssueStatus({ ...input, project });
    },
    onSuccess: invalidate,
  });
}
