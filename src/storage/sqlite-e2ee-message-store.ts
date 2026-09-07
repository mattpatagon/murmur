import type { Database } from "bun:sqlite";

import type { MarkMessagesReadInput, MarkMessagesReadOutput } from "../domain/contracts.js";
import { SessionKey } from "../domain/lifecycle-values.js";
import { AgentId, type Clock, type Instant, type TenantId } from "../domain/value-objects.js";
import { ordinaryClaimedProvenance } from "../e2ee/claimed-provenance.js";
import {
  verifyHostedEncryptedEnvelope,
  verifyHostedPublicBundle,
} from "../e2ee/hosted-validation.js";
import { MAX_E2EE_CIPHERTEXT_BYTES } from "../e2ee/wire-contracts.js";
import type {
  AcknowledgeEncryptedMessagesOutput,
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
import { logSafeError } from "../safe-errors.js";
import type {
  E2eeMessageStore,
  E2eeWriteAuthorization,
  EncryptedInboxUpdateHandler,
} from "./e2ee-message-store.js";
import type { InboxSubscription } from "./message-store.js";
import { renewSqliteSession } from "./sqlite-agent-lifecycle-store.js";
import {
  cancelSqliteEncryptedBroadcast,
  commitSqliteEncryptedBroadcast,
} from "./sqlite-e2ee-broadcast-finalize.js";
import {
  prepareSqliteEncryptedBroadcast,
  putSqliteEncryptedBroadcastDelivery,
} from "./sqlite-e2ee-broadcasts.js";
import { claimSqliteEncryptionPrekey, publishSqliteAgentKeyBundle } from "./sqlite-e2ee-keys.js";
import {
  acknowledgeSqliteEncryptedMessages,
  existingSqliteEncryptedMessageOutput,
  getSqliteEncryptedInboxSummary,
  getSqliteEncryptedMessages,
  markSqliteEncryptedMessagesRead,
  putSqliteEncryptedMessage,
} from "./sqlite-e2ee-messages.js";
import { pruneSqliteE2ee } from "./sqlite-e2ee-prune.js";
import {
  type SqliteHostedEnvelopeValidationContext,
  sqliteHostedEnvelopeValidationContext,
} from "./sqlite-e2ee-validation-context.js";

const SQLITE_WATCH_INTERVAL_MS: number = 200;
type IntervalHandle = ReturnType<typeof setInterval>;

class SqliteEncryptedInboxSubscription implements InboxSubscription {
  private closed: boolean;
  private readonly handler: EncryptedInboxUpdateHandler;
  private previousSequence: number;
  private running: boolean;
  private readonly store: SqliteE2eeMessageStore;
  private timer: IntervalHandle | null;
  private readonly agentId: string;

  public constructor(
    store: SqliteE2eeMessageStore,
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ) {
    this.agentId = agentId;
    this.closed = false;
    this.handler = handler;
    this.previousSequence = afterSequence;
    this.running = false;
    this.store = store;
    this.timer = setInterval((): void => {
      void this.check();
    }, SQLITE_WATCH_INTERVAL_MS);
    void this.check();
  }

  private async check(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const summary: GetInboxSummaryOutput = this.store.getEncryptedInboxSummary({
        agent_id: this.agentId,
      });
      if (summary.inbox_version > this.previousSequence) {
        await this.handler(summary.inbox_version);
        this.previousSequence = summary.inbox_version;
      }
    } catch (error: unknown) {
      logSafeError("Murmur SQLite encrypted inbox watcher error", error);
    } finally {
      this.running = false;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export class SqliteE2eeMessageStore implements E2eeMessageStore {
  private readonly clock: Clock;
  private readonly database: Database;
  private readonly ensureParentOpen: () => void;
  private readonly tenantId: TenantId;

  public constructor(
    database: Database,
    clock: Clock,
    tenantId: TenantId,
    ensureParentOpen: () => void,
  ) {
    this.clock = clock;
    this.database = database;
    this.ensureParentOpen = ensureParentOpen;
    this.tenantId = tenantId;
  }

  public scopeE2ee(tenantId: TenantId): E2eeMessageStore {
    this.ensureOpen();
    if (!tenantId.equals(this.tenantId)) {
      throw new Error("SQLite storage supports only the founding tenant");
    }
    return this;
  }

  private ensureOpen(): void {
    this.ensureParentOpen();
  }

  private prune(): void {
    this.ensureOpen();
    pruneSqliteE2ee(this.database, this.clock.now());
  }

  public async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    this.prune();
    const now: Instant = this.clock.now();
    await verifyHostedPublicBundle(input.agent_id, input.bundle, new Date(now.toISOString()), 20);
    return publishSqliteAgentKeyBundle(this.database, input, now);
  }

  public claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
    authorization?: E2eeWriteAuthorization,
  ): ClaimEncryptionPrekeyOutput {
    this.prune();
    return claimSqliteEncryptionPrekey(
      this.database,
      input,
      this.clock.now(),
      authorization === undefined ? ordinaryClaimedProvenance("peer") : authorization.provenance,
    );
  }

  public async putEncryptedMessage(
    input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    this.prune();
    const prior: PutEncryptedMessageOutput | null = existingSqliteEncryptedMessageOutput(
      this.database,
      input,
    );
    if (prior !== null) return prior;
    const now: Instant = this.clock.now();
    const validation: SqliteHostedEnvelopeValidationContext = sqliteHostedEnvelopeValidationContext(
      this.database,
      input.claim_id,
    );
    await verifyHostedEncryptedEnvelope({
      ...validation,
      expectedBroadcastId: null,
      maxCiphertextBytes: MAX_E2EE_CIPHERTEXT_BYTES,
      now: new Date(now.toISOString()),
      putInput: input,
      tenantId: this.tenantId.value,
    });
    return putSqliteEncryptedMessage(this.database, this.tenantId.value, input, now);
  }

  public getEncryptedMessages(input: GetEncryptedMessagesInput): EncryptedInboxOutput {
    this.prune();
    this.renewReadSession(input.agent_id, input.session_key);
    return getSqliteEncryptedMessages(this.database, input, this.clock.now());
  }

  public markEncryptedMessagesRead(input: MarkMessagesReadInput): MarkMessagesReadOutput {
    this.prune();
    this.renewReadSession(input.agent_id, input.session_key);
    return markSqliteEncryptedMessagesRead(this.database, input, this.clock.now());
  }

  public acknowledgeEncryptedMessages(
    input: MarkMessagesReadInput,
  ): AcknowledgeEncryptedMessagesOutput {
    this.prune();
    this.renewReadSession(input.agent_id, input.session_key);
    return acknowledgeSqliteEncryptedMessages(this.database, input, this.clock.now());
  }

  public prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): PrepareEncryptedBroadcastOutput {
    this.prune();
    return prepareSqliteEncryptedBroadcast(
      this.database,
      input,
      this.clock.now(),
      authorization === undefined ? ordinaryClaimedProvenance("peer") : authorization.provenance,
    );
  }

  public async putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
    authorization?: E2eeWriteAuthorization,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    this.prune();
    const now: Instant = this.clock.now();
    const validation: SqliteHostedEnvelopeValidationContext = sqliteHostedEnvelopeValidationContext(
      this.database,
      input.claim_id,
    );
    await verifyHostedEncryptedEnvelope({
      ...validation,
      expectedBroadcastId: input.broadcast_id,
      maxCiphertextBytes: MAX_E2EE_CIPHERTEXT_BYTES,
      now: new Date(now.toISOString()),
      putInput: { claim_id: input.claim_id, envelope: input.envelope },
      tenantId: this.tenantId.value,
    });
    return putSqliteEncryptedBroadcastDelivery(
      this.database,
      this.tenantId.value,
      input,
      now,
      authorization ?? {
        boundSenderId: null,
        orchestrationScope: null,
        provenance: ordinaryClaimedProvenance("peer"),
      },
    );
  }

  public commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): CommitEncryptedBroadcastOutput {
    this.prune();
    return commitSqliteEncryptedBroadcast(
      this.database,
      input,
      this.clock.now(),
      authorization ?? {
        boundSenderId: null,
        orchestrationScope: null,
        provenance: ordinaryClaimedProvenance("peer"),
      },
    );
  }

  public cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
    authorization?: E2eeWriteAuthorization,
  ): CancelEncryptedBroadcastOutput {
    this.prune();
    return cancelSqliteEncryptedBroadcast(
      this.database,
      input,
      authorization ?? {
        boundSenderId: null,
        orchestrationScope: null,
        provenance: ordinaryClaimedProvenance("peer"),
      },
    );
  }

  public getEncryptedInboxSummary(input: GetInboxSummaryInput): GetInboxSummaryOutput {
    this.prune();
    this.renewReadSession(input.agent_id, input.session_key);
    return getSqliteEncryptedInboxSummary(this.database, input, this.clock.now());
  }

  private renewReadSession(agentId: string, sessionKey: string | undefined): void {
    if (sessionKey === undefined) return;
    renewSqliteSession(
      this.database,
      AgentId.parse(agentId),
      SessionKey.parse(sessionKey),
      this.clock.now(),
      false,
    );
  }

  public watchEncryptedInbox(
    agentId: string,
    afterSequence: number,
    handler: EncryptedInboxUpdateHandler,
  ): InboxSubscription {
    this.prune();
    getSqliteEncryptedInboxSummary(this.database, { agent_id: agentId }, this.clock.now());
    return new SqliteEncryptedInboxSubscription(this, agentId, afterSequence, handler);
  }

  public close(): void {}
}
