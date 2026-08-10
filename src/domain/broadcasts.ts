import type { BroadcastMessageCommand } from "./models.js";

export type StoredBroadcastRequest = {
  readonly audienceMachineName: string | null;
  readonly audienceRepositoryName: string | null;
  readonly branchName: string;
  readonly clientName: string;
  readonly content: string;
  readonly repositoryName: string;
  readonly senderAuthority: string;
  readonly threadId: string;
};

function nullableValueEquals(
  stored: string | null,
  requested: { readonly value: string } | null,
): boolean {
  return (
    (stored === null && requested === null) ||
    (stored !== null && requested !== null && stored === requested.value)
  );
}

export function broadcastRequestMatches(
  stored: StoredBroadcastRequest,
  command: BroadcastMessageCommand,
): boolean {
  const requestedAuthority: string = command.senderAuthority ?? "peer";
  const sameThread: boolean =
    command.threadId === null || stored.threadId === command.threadId.value;
  return (
    stored.content === command.content.value &&
    nullableValueEquals(stored.audienceMachineName, command.audience.machineName) &&
    nullableValueEquals(stored.audienceRepositoryName, command.audience.repositoryName) &&
    nullableValueEquals(stored.branchName, command.branchName) &&
    nullableValueEquals(stored.clientName, command.client) &&
    nullableValueEquals(stored.repositoryName, command.repositoryName) &&
    stored.senderAuthority === requestedAuthority &&
    sameThread
  );
}
