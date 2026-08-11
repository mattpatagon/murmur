import { randomBytes, randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { TenantId } from "../../src/domain/value-objects.js";
import { type PostgresTlsConfiguration, postgresSslOptions } from "../../src/postgres-tls.js";

export type PostgresE2eeTestTenant = {
  readonly actorTokenId: string;
  readonly applicationName: string;
  readonly tenantId: TenantId;
  beginProvisioning(): Promise<void>;
  blockPlaintextWrites(): Promise<void>;
  close(): Promise<void>;
  configureOrchestrator(agentId: string, repository: string): Promise<string>;
  enforce(): Promise<void>;
  finishEnforcement(): Promise<void>;
  resetIdentity(agentId: string, rootKeyId: string): Promise<void>;
  rollback(): Promise<void>;
  rotateOrchestrator(policyId: string, agentId: string): Promise<void>;
};

const ChangedRowSchema: z.ZodType<[{ readonly changed: true }]> = z.tuple([
  z.strictObject({ changed: z.literal(true) }),
]);

export async function createPostgresE2eeTestTenant(
  databaseUrl: string,
  tlsConfiguration: PostgresTlsConfiguration,
): Promise<PostgresE2eeTestTenant> {
  const tenantId: TenantId = TenantId.generate();
  const unique: string = tenantId.value.replaceAll("-", "").slice(0, 12);
  const applicationName: string = `murmur-e2ee-tenant-${unique}`;
  const database: Sql = postgres(databaseUrl, {
    connect_timeout: 10,
    connection: { application_name: applicationName },
    max: 1,
    ssl: postgresSslOptions(databaseUrl, tlsConfiguration),
  });
  const actorTokenId: string = randomUUID();
  try {
    await database`
      INSERT INTO murmur.tenants(tenant_id, slug, display_name)
      VALUES (${tenantId.value}::uuid, ${`e2ee-test-${unique}`}, 'E2E storage test tenant')
    `;
    await database`
      INSERT INTO murmur.access_tokens(
        token_id, tenant_id, key_id, secret_hash, token_role, name
      ) VALUES (
        ${actorTokenId}::uuid, ${tenantId.value}::uuid, ${`E2eAdm${unique}`},
        ${randomBytes(32)}, 'tenant_admin', 'E2E storage test administrator'
      )
    `;
  } catch (error: unknown) {
    await database.end({ timeout: 1 });
    throw error;
  }

  const transition: (
    action: string,
    expectedState: string,
    trustPolicyVersion: number | null,
  ) => Promise<void> = async (
    action: string,
    expectedState: string,
    trustPolicyVersion: number | null,
  ): Promise<void> => {
    const raw: unknown = await database`
      SELECT murmur.tenant_transition_e2ee(
        ${tenantId.value}::uuid, ${actorTokenId}::uuid, ${action}, ${expectedState},
        ${trustPolicyVersion}
      ) AS changed
    `;
    ChangedRowSchema.parse(raw);
  };

  const insertOrchestratorToken: (agentId: string) => Promise<string> = async (
    agentId: string,
  ): Promise<string> => {
    const tokenId: string = randomUUID();
    const tokenUnique: string = tokenId.replaceAll("-", "").slice(0, 12);
    await database`
      INSERT INTO murmur.access_tokens(
        token_id, tenant_id, key_id, secret_hash, token_role, name, orchestrator_agent_id
      ) VALUES (
        ${tokenId}::uuid, ${tenantId.value}::uuid, ${`E2eOrc${tokenUnique}`},
        ${randomBytes(32)}, 'orchestrator', 'E2E storage test orchestrator', ${agentId}
      )
    `;
    return tokenId;
  };

  return {
    actorTokenId,
    applicationName,
    beginProvisioning: async (): Promise<void> =>
      await transition("begin_provisioning", "off", null),
    blockPlaintextWrites: async (): Promise<void> =>
      await transition("block_plaintext_writes", "provisioning", null),
    close: async (): Promise<void> => await database.end({ timeout: 1 }),
    configureOrchestrator: async (agentId: string, repository: string): Promise<string> => {
      const tokenId: string = await insertOrchestratorToken(agentId);
      const policyId: string = randomUUID();
      await database`
        INSERT INTO murmur.orchestrator_policies(
          policy_id, tenant_id, scope_kind, scope_owner_id, repository_name,
          orchestrator_token_id, instructions, created_by_token_id, updated_by_token_id
        ) VALUES (
          ${policyId}::uuid, ${tenantId.value}::uuid, 'organization', ${tenantId.value}::uuid,
          ${repository}, ${tokenId}::uuid, 'E2E revalidation test policy',
          ${actorTokenId}::uuid, ${actorTokenId}::uuid
        )
      `;
      return policyId;
    },
    enforce: async (): Promise<void> => {
      await transition("block_plaintext_writes", "provisioning", null);
      await transition("enforce", "provisioning", 1);
    },
    finishEnforcement: async (): Promise<void> => await transition("enforce", "provisioning", 1),
    resetIdentity: async (agentId: string, rootKeyId: string): Promise<void> => {
      const raw: unknown = await database`
        SELECT murmur.tenant_reset_e2ee_identity(
          ${tenantId.value}::uuid, ${actorTokenId}::uuid, ${agentId}, ${rootKeyId},
          'Deterministic hosted E2E concurrency regression'
        ) AS changed
      `;
      ChangedRowSchema.parse(raw);
    },
    rollback: async (): Promise<void> => await transition("rollback_off", "enforced", null),
    rotateOrchestrator: async (policyId: string, agentId: string): Promise<void> => {
      await database.begin(async (transaction: TransactionSql): Promise<void> => {
        await transaction`
          UPDATE murmur.access_tokens AS token
          SET revoked_at = pg_catalog.statement_timestamp()
          FROM murmur.orchestrator_policies AS policy
          WHERE policy.tenant_id = ${tenantId.value}::uuid
            AND policy.policy_id = ${policyId}::uuid
            AND token.tenant_id = policy.tenant_id
            AND token.token_id = policy.orchestrator_token_id
        `;
        const tokenId: string = randomUUID();
        const tokenUnique: string = tokenId.replaceAll("-", "").slice(0, 12);
        await transaction`
          INSERT INTO murmur.access_tokens(
            token_id, tenant_id, key_id, secret_hash, token_role, name, orchestrator_agent_id
          ) VALUES (
            ${tokenId}::uuid, ${tenantId.value}::uuid, ${`E2eOrc${tokenUnique}`},
            ${randomBytes(32)}, 'orchestrator', 'Rotated E2E storage test orchestrator', ${agentId}
          )
        `;
        await transaction`
          UPDATE murmur.orchestrator_policies
          SET orchestrator_token_id = ${tokenId}::uuid,
            updated_by_token_id = ${actorTokenId}::uuid,
            updated_at = pg_catalog.statement_timestamp()
          WHERE tenant_id = ${tenantId.value}::uuid AND policy_id = ${policyId}::uuid
        `;
      });
    },
    tenantId,
  };
}
