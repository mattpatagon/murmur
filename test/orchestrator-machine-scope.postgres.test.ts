import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";

import { PersonalId } from "../src/domain/orchestration.js";
import { MachineName, RepositoryName, TenantId } from "../src/domain/value-objects.js";
import type {
  EffectiveOrchestrator,
  TenantPrincipal,
} from "../src/hosted/control-plane-contracts.js";
import { resolvePostgresOrchestrator } from "../src/hosted/orchestration-control-plane.js";
import { POSTGRES_RUNTIME_CONNECTION } from "../src/postgres-runtime.js";
import { postgresSslOptions } from "../src/postgres-tls.js";
import type { E2eeWriteAuthorization } from "../src/storage/e2ee-message-store.js";
import { requireEffectivePostgresOrchestratorClaim } from "../src/storage/postgres-e2ee-keys.js";
import { setPostgresTenantContext } from "../src/storage/postgres-message-transactions.js";
import {
  adminDatabaseUrl,
  databaseUrl,
  testTlsConfiguration,
} from "./support/hosted-mcp-harness.js";

const configured: boolean = databaseUrl !== undefined && adminDatabaseUrl !== undefined;
const REPOSITORY: string = "mattpatagon/murmur";
const MACHINE: string = "build-host-01";

type PolicyFixture = {
  readonly kind: "organization" | "personal";
  readonly label: string;
  readonly machine: string;
  readonly repository: string;
};

const POLICY_ORDER: readonly PolicyFixture[] = [
  { kind: "personal", label: "personal-both", machine: MACHINE, repository: REPOSITORY },
  { kind: "organization", label: "organization-both", machine: MACHINE, repository: REPOSITORY },
  { kind: "personal", label: "personal-repository", machine: "", repository: REPOSITORY },
  { kind: "personal", label: "personal-machine", machine: MACHINE, repository: "" },
  { kind: "organization", label: "organization-repository", machine: "", repository: REPOSITORY },
  { kind: "organization", label: "organization-machine", machine: MACHINE, repository: "" },
  { kind: "personal", label: "personal-global", machine: "", repository: "" },
  { kind: "organization", label: "organization-global", machine: "", repository: "" },
];

type Fixture = {
  readonly admin: Sql;
  readonly app: Sql;
  readonly personalId: PersonalId;
  readonly policyIds: ReadonlyMap<string, string>;
  readonly tenantId: TenantId;
};

async function deleteTenant(admin: Sql, tenantId: TenantId): Promise<void> {
  await admin`DELETE FROM murmur.orchestrator_policies WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.access_tokens WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_resource_usage WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_message_sequences WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_e2ee_usage WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenant_e2ee_state WHERE tenant_id = ${tenantId.value}::uuid`;
  await admin`DELETE FROM murmur.tenants WHERE tenant_id = ${tenantId.value}::uuid`;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || adminDatabaseUrl === undefined) {
    throw new Error("Disposable PostgreSQL URLs are required");
  }
  const admin: Sql = postgres(adminDatabaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(adminDatabaseUrl, testTlsConfiguration),
  });
  const app: Sql = postgres(databaseUrl, {
    connection: POSTGRES_RUNTIME_CONNECTION,
    max: 1,
    ssl: postgresSslOptions(databaseUrl, testTlsConfiguration),
  });
  const tenantId: TenantId = TenantId.generate();
  const personalId: PersonalId = PersonalId.generate();
  const orchestratorTokenId: string = randomUUID();
  const policyIds: Map<string, string> = new Map<string, string>();
  try {
    await admin.begin(async (transaction: TransactionSql): Promise<void> => {
      await transaction`INSERT INTO murmur.tenants(tenant_id, slug, display_name)
        VALUES (${tenantId.value}::uuid, ${`machine-scope-${tenantId.value}`}, 'Machine scope')`;
      await transaction`INSERT INTO murmur.access_tokens(
          token_id, tenant_id, key_id, secret_hash, token_role, name,
          personal_id, orchestrator_agent_id
        ) VALUES (
          ${orchestratorTokenId}::uuid, ${tenantId.value}::uuid,
          ${orchestratorTokenId.replaceAll("-", "")}, ${randomBytes(32)}, 'orchestrator',
          'Machine scope orchestrator', ${personalId.value}::uuid, 'machine-scope-orchestrator'
        )`;
      for (const policy of POLICY_ORDER) {
        const policyId: string = randomUUID();
        policyIds.set(policy.label, policyId);
        await transaction`INSERT INTO murmur.orchestrator_policies(
            policy_id, tenant_id, scope_kind, scope_owner_id, repository_name, machine_name,
            orchestrator_token_id, instructions, created_by_token_id, updated_by_token_id
          ) VALUES (
            ${policyId}::uuid, ${tenantId.value}::uuid, ${policy.kind},
            ${policy.kind === "personal" ? personalId.value : tenantId.value}::uuid,
            ${policy.repository}, ${policy.machine}, ${orchestratorTokenId}::uuid,
            ${policy.label}, ${orchestratorTokenId}::uuid, ${orchestratorTokenId}::uuid
          )`;
      }
    });
    await run({ admin, app, personalId, policyIds, tenantId });
  } finally {
    try {
      await app.end({ timeout: 1 });
    } finally {
      try {
        await deleteTenant(admin, tenantId);
      } finally {
        await admin.end({ timeout: 1 });
      }
    }
  }
}

function principal(
  fixture: Fixture,
  repositoryName: RepositoryName | null,
  machineName: MachineName | null,
): TenantPrincipal {
  return {
    kind: "tenant",
    machineName,
    personalId: fixture.personalId,
    repositoryName,
    role: "agent",
    tenantId: fixture.tenantId,
    tokenId: randomUUID(),
  };
}

function policyId(fixture: Fixture, label: string): string {
  const value: string | undefined = fixture.policyIds.get(label);
  if (value === undefined) throw new Error(`Missing policy fixture ${label}`);
  return value;
}

async function resolvedPolicyId(
  fixture: Fixture,
  tenantPrincipal: TenantPrincipal,
): Promise<string | null> {
  const resolved: EffectiveOrchestrator | null = await resolvePostgresOrchestrator(
    fixture.app,
    tenantPrincipal,
  );
  return resolved === null ? null : resolved.policyId.value;
}

async function requireE2eePolicy(
  fixture: Fixture,
  machineName: string | null,
  expectedLabel: string,
): Promise<void> {
  const authorization: E2eeWriteAuthorization = {
    boundSenderId: null,
    orchestrationScope: {
      machineName,
      personalId: fixture.personalId.value,
      repositoryName: REPOSITORY,
    },
    provenance: {
      message_kind: "orchestration_request",
      orchestrator_policy_id: policyId(fixture, expectedLabel),
      sender_authority: "peer",
    },
  };
  await fixture.app.begin(async (transaction: TransactionSql): Promise<void> => {
    await setPostgresTenantContext(transaction, fixture.tenantId);
    await requireEffectivePostgresOrchestratorClaim(
      transaction,
      fixture.tenantId,
      {
        context: { branch: "machine-scope", client: "codex", repository: REPOSITORY },
        recipient_id: "machine-scope-orchestrator",
        sender_id: "machine-scope-worker",
      },
      authorization,
      policyId(fixture, expectedLabel),
      null,
    );
  });
}

test.skipIf(!configured)(
  "machine orchestration resolves all eight scopes in deterministic precedence",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const bound: TenantPrincipal = principal(
        fixture,
        RepositoryName.parse(REPOSITORY),
        MachineName.parse(MACHINE),
      );
      for (const expected of POLICY_ORDER) {
        expect(await resolvedPolicyId(fixture, bound)).toBe(policyId(fixture, expected.label));
        await fixture.admin`UPDATE murmur.orchestrator_policies SET enabled = false
          WHERE tenant_id = ${fixture.tenantId.value}::uuid
            AND policy_id = ${policyId(fixture, expected.label)}::uuid`;
      }
      expect(await resolvedPolicyId(fixture, bound)).toBeNull();
    });
  },
  20_000,
);

test.skipIf(!configured)(
  "machine-qualified policies fall back without trusting absent or mismatched machine context",
  async (): Promise<void> => {
    await withFixture(async (fixture: Fixture): Promise<void> => {
      const repository: RepositoryName = RepositoryName.parse(REPOSITORY);
      const machine: MachineName = MachineName.parse(MACHINE);
      expect(await resolvedPolicyId(fixture, principal(fixture, repository, null))).toBe(
        policyId(fixture, "personal-repository"),
      );
      expect(
        await resolvedPolicyId(
          fixture,
          principal(fixture, repository, MachineName.parse("other-host")),
        ),
      ).toBe(policyId(fixture, "personal-repository"));
      expect(await resolvedPolicyId(fixture, principal(fixture, null, machine))).toBe(
        policyId(fixture, "personal-machine"),
      );
      expect(await resolvedPolicyId(fixture, principal(fixture, null, null))).toBe(
        policyId(fixture, "personal-global"),
      );
      await requireE2eePolicy(fixture, MACHINE, "personal-both");
      await requireE2eePolicy(fixture, "other-host", "personal-repository");
    });
  },
  20_000,
);
