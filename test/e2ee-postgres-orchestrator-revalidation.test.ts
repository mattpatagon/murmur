import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  type CanaryE2eeIdentity,
  createCanaryE2eeIdentity,
  encryptCanaryE2eeMessage,
} from "../scripts/lib/e2ee-canary-crypto.js";
import { AgentId, DisplayName } from "../src/domain/value-objects.js";
import type {
  ClaimEncryptionPrekeyOutput,
  PutEncryptedMessageInput,
} from "../src/e2ee/wire-tools.js";
import type {
  E2eeMessageStore,
  E2eeWriteAuthorization,
} from "../src/storage/e2ee-message-store.js";
import type { MessageStore } from "../src/storage/message-store.js";
import { PostgresMessageStore } from "../src/storage/postgres-message-store.js";
import { testE2eeBundle } from "./support/e2ee-hosted-crypto.js";
import {
  createPostgresE2eeTestTenant,
  type PostgresE2eeTestTenant,
} from "./support/e2ee-postgres-tenant.js";
import { adminDatabaseUrl, testTlsConfiguration } from "./support/hosted-mcp-harness.js";

const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
const postgresConfigured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;

test.skipIf(!postgresConfigured)(
  "PostgreSQL rejects an orchestrator claim after its policy rotates credentials",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    if (configuredDatabaseUrl === undefined || configuredAdminDatabaseUrl === undefined) {
      throw new Error("Hosted database URLs are required");
    }
    const testTenant: PostgresE2eeTestTenant = await createPostgresE2eeTestTenant(
      configuredAdminDatabaseUrl,
      testTlsConfiguration,
    );
    const store: PostgresMessageStore = await PostgresMessageStore.connect(
      configuredDatabaseUrl,
      testTlsConfiguration,
    );
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 10);
    const senderId: string = `e2ee-worker-${unique}`;
    const orchestratorId: string = `e2ee-orchestrator-${unique}`;
    const repository: string = `e2ee-test/orchestrator-${unique}`;
    try {
      await testTenant.beginProvisioning();
      const tenantStore: MessageStore = store.scope(testTenant.tenantId);
      for (const agentId of [senderId, orchestratorId]) {
        await tenantStore.registerAgent({
          agentId: AgentId.parse(agentId),
          displayName: DisplayName.parse(agentId),
          metadata: { machine: `${agentId}-machine`, repository },
        });
      }
      const now: Date = new Date();
      const sender: CanaryE2eeIdentity = await createCanaryE2eeIdentity(senderId, now);
      const orchestrator: CanaryE2eeIdentity = await createCanaryE2eeIdentity(orchestratorId, now);
      const encrypted: E2eeMessageStore = store.scopeE2ee(testTenant.tenantId);
      await encrypted.publishAgentKeyBundle({ agent_id: senderId, bundle: testE2eeBundle(sender) });
      await encrypted.publishAgentKeyBundle({
        agent_id: orchestratorId,
        bundle: testE2eeBundle(orchestrator),
      });
      await testTenant.enforce();
      const policyId: string = await testTenant.configureOrchestrator(orchestratorId, repository);
      const authorization: E2eeWriteAuthorization = {
        boundSenderId: null,
        orchestrationScope: { personalId: randomUUID(), repositoryName: repository },
        provenance: {
          message_kind: "orchestration_request",
          orchestrator_policy_id: policyId,
          sender_authority: "peer",
        },
      };
      const claim: ClaimEncryptionPrekeyOutput = await encrypted.claimEncryptionPrekey(
        {
          context: { branch: "feature/hosted-e2ee", client: "codex", repository },
          recipient_id: orchestratorId,
          sender_id: senderId,
        },
        authorization,
      );
      const put: PutEncryptedMessageInput = await encryptCanaryE2eeMessage({
        claim,
        idempotencyKey: `orchestrator-rotation-${unique}`,
        pairCounter: 1,
        plaintext: "orchestrator credential rotation sentinel",
        recipient: orchestrator,
        repository,
        sender,
        senderId,
        tenantId: testTenant.tenantId.value,
      });
      await testTenant.rotateOrchestrator(policyId, orchestratorId);
      await expect(encrypted.putEncryptedMessage(put, authorization)).rejects.toThrow(
        "Effective orchestrator changed before encryption claim commit",
      );
    } finally {
      await store.close();
      await testTenant.close();
    }
  },
  20_000,
);
