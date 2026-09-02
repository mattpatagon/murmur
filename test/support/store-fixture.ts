import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BroadcastMessageCommand, SendMessageCommand } from "../../src/domain/models.js";
import {
  AgentClient,
  AgentId,
  BranchName,
  type Clock,
  DisplayName,
  IdempotencyKey,
  Instant,
  MessageContent,
  RepositoryName,
} from "../../src/domain/value-objects.js";
import { SqliteMessageStore } from "../../src/storage/sqlite-message-store.js";

export class MutableClock implements Clock {
  private current: Instant;

  public constructor(initial: Instant) {
    this.current = initial;
  }

  public now(): Instant {
    return this.current;
  }

  public set(instant: Instant): void {
    this.current = instant;
  }
}

export type StoreFixture = {
  readonly clock: MutableClock;
  readonly store: SqliteMessageStore;
};

export function withFixture(run: (fixture: StoreFixture) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-store-"));
  const clock: MutableClock = new MutableClock(Instant.parse("2026-08-04T12:00:00.000Z"));
  const store: SqliteMessageStore = new SqliteMessageStore(join(directory, "messages.db"), clock);
  try {
    store.registerAgent({
      agentId: AgentId.parse("alice"),
      displayName: DisplayName.parse("Alice"),
      metadata: {},
    });
    store.registerAgent({
      agentId: AgentId.parse("bob"),
      displayName: DisplayName.parse("Bob"),
      metadata: {},
    });
    run({ clock, store });
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

export function baseMessageCommand(): SendMessageCommand {
  return {
    branchName: BranchName.parse("feature/agent-context"),
    client: AgentClient.parse("connector"),
    content: MessageContent.parse("Can you review this?"),
    idempotencyKey: IdempotencyKey.parse("review-1"),
    recipientId: AgentId.parse("bob"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    senderId: AgentId.parse("alice"),
    threadId: null,
  };
}

export function baseBroadcastCommand(): BroadcastMessageCommand {
  return {
    audience: { machineName: null, repositoryName: null },
    branchName: BranchName.parse("feature/broadcasts"),
    client: AgentClient.parse("connector"),
    content: MessageContent.parse("Attention all active agents"),
    idempotencyKey: IdempotencyKey.parse("broadcast-1"),
    repositoryName: RepositoryName.parse("mattpatagon/murmur"),
    senderId: AgentId.parse("alice"),
    threadId: null,
  };
}
