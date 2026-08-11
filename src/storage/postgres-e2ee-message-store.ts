import type { Sql } from "postgres";

import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../domain/contracts.js";
import {
  AgentId,
  type Clock,
  type Instant,
  Sequence,
  type TenantId,
} from "../domain/value-objects.js";
import { ordinaryClaimedProvenance } from "../e2ee/claimed-provenance.js";
import { verifyHostedPublicBundle } from "../e2ee/hosted-validation.js";
import type {
  CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastOutput,
  ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyOutput,
  CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastOutput,
  EncryptedInboxOutput,
  GetEncryptedMessagesInput,
  GetInboxSummaryInput,
  GetInboxSummaryOutput,
  PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastOutput,
  PublishAgentKeyBundleInput,
  PublishAgentKeyBundleOutput,
  PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedMessageInput,
  PutEncryptedMessageOutput,
} from "../e2ee/wire-tools.js";
import { HOSTED_MAX_ONE_TIME_PREKEYS } from "../hosted/e2ee-entitlement.js";
import type {
  E2eeMessageStore,
  E2eeWriteAuthorization,
  EncryptedInboxUpdateHandler,
} from "./e2ee-message-store.js";
import type { InboxSubscription, InboxUpdateHandler } from "./message-store.js";
import { putPostgresEncryptedBroadcastDelivery } from "./postgres-e2ee-broadcast-delivery.js";
import {
  cancelPostgresEncryptedBroadcast,
  commitPostgresEncryptedBroadcast,
} from "./postgres-e2ee-broadcast-finalize.js";
import { preparePostgresEncryptedBroadcast } from "./postgres-e2ee-broadcast-prepare.js";
import {
  getPostgresEncryptedInboxSummary,
  getPostgresEncryptedMessages,
  markPostgresEncryptedMessagesRead,
} from "./postgres-e2ee-inbox.js";
import {
  claimPostgresEncryptionPrekey,
  publishPostgresAgentKeyBundle,
} from "./postgres-e2ee-keys.js";
import { putPostgresEncryptedMessage } from "./postgres-e2ee-messages.js";
import { prunePostgresE2ee } from "./postgres-e2ee-prune.js";

export type PostgresEncryptedInboxWatcher = (
  agentId: string,
  afterSequence: number,
  handler: EncryptedInboxUpdateHandler,
) => Promise<InboxSubscription>;

export type PostgresPlaintextInboxWatcher = (
  agentId: AgentId,
  afterSequence: Sequence,
  handler: InboxUpdateHandler,
) => Promise<InboxSubscription>;

export function createPostgresE2eeMessageStore(
  database: Sql,
  clock: Clock,
  tenantId: TenantId,
  ensureParentOpen: () => void,
  watchInbox: PostgresPlaintextInboxWatcher,
): E2eeMessageStore {
  const watcher: PostgresEncryptedInboxWatcher = async (
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ): Promise<InboxSubscription> =>
    await watchInbox(
      AgentId.parse(agentId),
      Sequence.parse(afterSequence),
      async (sequence: Sequence): Promise<void> => await handler(sequence.value),
    );
  return new PostgresE2eeMessageStore(database, clock, tenantId, ensureParentOpen, watcher);
}

function ordinaryAuthorization(): E2eeWriteAuthorization {
  return {
    boundSenderId: null,
    orchestrationScope: null,
    provenance: ordinaryClaimedProvenance("peer"),
  };
}

export class PostgresE2eeMessageStore implements E2eeMessageStore {
  private readonly clock: Clock;
  private readonly database: Sql;
  private readonly ensureParentOpen: () => void;
  private readonly tenantId: TenantId;
  private readonly watcher: PostgresEncryptedInboxWatcher;

  public constructor(
    database: Sql,
    clock: Clock,
    tenantId: TenantId,
    ensureParentOpen: () => void,
    watcher: PostgresEncryptedInboxWatcher,
  ) {
    this.clock = clock;
    this.database = database;
    this.ensureParentOpen = ensureParentOpen;
    this.tenantId = tenantId;
    this.watcher = watcher;
  }

  public scopeE2ee(tenantId: TenantId): E2eeMessageStore {
    this.ensureOpen();
    if (!tenantId.equals(this.tenantId)) throw new Error("Encrypted tenant scope is inconsistent");
    return this;
  }

  private ensureOpen(): void {
    this.ensureParentOpen();
  }

  private async prune(now: Instant): Promise<void> {
    this.ensureOpen();
    await prunePostgresE2ee(this.database, this.tenantId, now);
  }

  public async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    await verifyHostedPublicBundle(
      input.agent_id,
      input.bundle,
      new Date(now.toISOString()),
      HOSTED_MAX_ONE_TIME_PREKEYS,
    );
    return await publishPostgresAgentKeyBundle(this.database, this.tenantId, input, now);
  }

  public async claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<ClaimEncryptionPrekeyOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await claimPostgresEncryptionPrekey(
      this.database,
      this.tenantId,
      input,
      authorization,
      now,
      null,
    );
  }

  public async putEncryptedMessage(
    input: PutEncryptedMessageInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<PutEncryptedMessageOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await putPostgresEncryptedMessage(
      this.database,
      this.tenantId,
      input,
      authorization,
      now,
    );
  }

  public async getEncryptedMessages(
    input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await getPostgresEncryptedMessages(this.database, this.tenantId, input, now);
  }

  public async markEncryptedMessagesRead(
    input: MarkMessagesReadInput,
  ): Promise<MarkMessagesReadOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await markPostgresEncryptedMessagesRead(this.database, this.tenantId, input, now);
  }

  public async prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<PrepareEncryptedBroadcastOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await preparePostgresEncryptedBroadcast(
      this.database,
      this.tenantId,
      input,
      authorization,
      now,
    );
  }

  public async putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await putPostgresEncryptedBroadcastDelivery(
      this.database,
      this.tenantId,
      input,
      authorization,
      now,
    );
  }

  public async commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<CommitEncryptedBroadcastOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await commitPostgresEncryptedBroadcast(
      this.database,
      this.tenantId,
      input,
      authorization,
      now,
    );
  }

  public async cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
    authorization: E2eeWriteAuthorization = ordinaryAuthorization(),
  ): Promise<CancelEncryptedBroadcastOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await cancelPostgresEncryptedBroadcast(
      this.database,
      this.tenantId,
      input,
      authorization,
    );
  }

  public async getEncryptedInboxSummary(
    input: GetInboxSummaryInput,
  ): Promise<GetInboxSummaryOutput> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    return await getPostgresEncryptedInboxSummary(this.database, this.tenantId, input, now);
  }

  public async watchEncryptedInbox(
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ): Promise<InboxSubscription> {
    const now: Instant = this.clock.now();
    await this.prune(now);
    await getPostgresEncryptedInboxSummary(
      this.database,
      this.tenantId,
      { agent_id: agentId },
      now,
    );
    return await this.watcher(agentId, afterSequence, handler);
  }

  public close(): void {}
}
