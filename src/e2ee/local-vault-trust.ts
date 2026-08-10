import type { Database, Statement } from "bun:sqlite";
import sodium from "libsodium-wrappers";
import { z } from "zod";

import { mapPeerPinRow, type PeerPin } from "./local-vault-rows.js";
import {
  type OrganizationTrustPolicy,
  type OrganizationTrustRevocation,
  verifyOrganizationTrustPolicy,
} from "./trust-policy.js";

export type StoredTrustPolicyState = {
  readonly expiresAt: string;
  readonly importedAt: string;
  readonly issuerKeyId: string;
  readonly issuerPublicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly tenantId: string;
  readonly version: number;
};

type TrustPolicyStateRow = {
  readonly expires_at: string;
  readonly imported_at: string;
  readonly issuer_key_id: string;
  readonly issuer_public_key: Uint8Array;
  readonly signature: Uint8Array;
  readonly tenant_id: string;
  readonly version: number;
};

const BytesSchema: z.ZodType<Uint8Array> = z
  .instanceof(Uint8Array)
  .transform((value: Uint8Array): Uint8Array => value.slice());
const SafeSqlIntegerSchema: z.ZodType<number> = z
  .union([z.number().int(), z.bigint()])
  .refine((value: number | bigint): boolean => Number.isSafeInteger(Number(value)))
  .transform((value: number | bigint): number => Number(value));
const TrustPolicyStateRowSchema: z.ZodType<TrustPolicyStateRow> = z.strictObject({
  expires_at: z.string(),
  imported_at: z.string(),
  issuer_key_id: z.string(),
  issuer_public_key: BytesSchema,
  signature: BytesSchema,
  tenant_id: z.string(),
  version: SafeSqlIntegerSchema,
});
const RootIdRowSchema: z.ZodType<{ readonly root_key_id: string }> = z.strictObject({
  root_key_id: z.string(),
});

function mapTrustPolicyState(input: unknown): StoredTrustPolicyState {
  const row: TrustPolicyStateRow = TrustPolicyStateRowSchema.parse(input);
  return {
    expiresAt: row.expires_at,
    importedAt: row.imported_at,
    issuerKeyId: row.issuer_key_id,
    issuerPublicKey: row.issuer_public_key,
    signature: row.signature,
    tenantId: row.tenant_id,
    version: row.version,
  };
}

export class LocalVaultTrust {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public getPolicyState(tenantId: string): StoredTrustPolicyState | null {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT tenant_id, issuer_key_id, issuer_public_key, version,
             expires_at, signature, imported_at
      FROM trust_policy_state WHERE tenant_id = ?
    `);
    const row: unknown = statement.get(tenantId);
    return row === null ? null : mapTrustPolicyState(row);
  }

  public revokedRootIds(tenantId: string): ReadonlySet<string> {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT root_key_id FROM trust_policy_revocations
      WHERE tenant_id = ? ORDER BY root_key_id
    `);
    const ids: Set<string> = new Set<string>();
    for (const input of statement.all(tenantId)) {
      ids.add(RootIdRowSchema.parse(input).root_key_id);
    }
    return ids;
  }

  #existingPins(tenantId: string): ReadonlyMap<string, PeerPin> {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT tenant_id, agent_id, root_key_id, public_key, verification_mode, verified_at
      FROM peer_pins WHERE tenant_id = ? ORDER BY agent_id
    `);
    const pins: Map<string, PeerPin> = new Map<string, PeerPin>();
    for (const input of statement.all(tenantId)) {
      const pin: PeerPin = mapPeerPinRow(input);
      pins.set(pin.agentId, pin);
    }
    return pins;
  }

  #assertUpdate(
    policy: OrganizationTrustPolicy,
    current: StoredTrustPolicyState | null,
    existingRevocations: ReadonlySet<string>,
  ): void {
    if (current !== null) {
      if (
        current.issuerKeyId !== policy.issuerKeyId ||
        !sodium.memcmp(current.issuerPublicKey, policy.issuerPublicKey)
      ) {
        throw new Error("Organization trust issuer changed and requires an audited reset");
      }
      if (policy.version <= current.version) {
        throw new Error("Organization trust policy version must advance");
      }
    }
    const nextRevocations: ReadonlySet<string> = new Set<string>(
      policy.revocations.map(
        (revocation: OrganizationTrustRevocation): string => revocation.rootKeyId,
      ),
    );
    for (const rootId of existingRevocations) {
      if (!nextRevocations.has(rootId)) {
        throw new Error("Organization trust policy cannot remove a revocation");
      }
    }
    const pins: ReadonlyMap<string, PeerPin> = this.#existingPins(policy.tenantId);
    for (const binding of policy.bindings) {
      const existing: PeerPin | undefined = pins.get(binding.agentId);
      if (
        existing !== undefined &&
        existing.rootKeyId !== binding.rootKeyId &&
        !nextRevocations.has(existing.rootKeyId)
      ) {
        throw new Error("Organization root rotation must revoke the prior root");
      }
    }
  }

  #writePolicy(policy: OrganizationTrustPolicy, importedAt: string): void {
    const stateStatement: Statement<
      unknown,
      [string, string, Uint8Array, number, string, Uint8Array, string]
    > = this.#database.query(`
      INSERT INTO trust_policy_state(
        tenant_id, issuer_key_id, issuer_public_key, version, expires_at, signature, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        issuer_key_id = excluded.issuer_key_id,
        issuer_public_key = excluded.issuer_public_key,
        version = excluded.version,
        expires_at = excluded.expires_at,
        signature = excluded.signature,
        imported_at = excluded.imported_at
    `);
    stateStatement.run(
      policy.tenantId,
      policy.issuerKeyId,
      policy.issuerPublicKey,
      policy.version,
      policy.expiresAt,
      policy.signature,
      importedAt,
    );
    const revocationStatement: Statement<unknown, [string, string, string, string]> =
      this.#database.query(`
        INSERT OR IGNORE INTO trust_policy_revocations(
          tenant_id, root_key_id, revoked_at, reason
        ) VALUES (?, ?, ?, ?)
      `);
    for (const revocation of policy.revocations) {
      revocationStatement.run(
        policy.tenantId,
        revocation.rootKeyId,
        revocation.revokedAt,
        revocation.reason,
      );
    }
    const deletePriorOrganizationPins: Statement<unknown, [string]> = this.#database.query(`
      DELETE FROM peer_pins WHERE tenant_id = ? AND verification_mode = 'organization'
    `);
    deletePriorOrganizationPins.run(policy.tenantId);
    const deleteRevokedPins: Statement<unknown, [string, string]> = this.#database.query(`
      DELETE FROM peer_pins WHERE tenant_id = ? AND root_key_id = ?
    `);
    for (const revocation of policy.revocations) {
      deleteRevokedPins.run(policy.tenantId, revocation.rootKeyId);
    }
    const upsertPin: Statement<unknown, [string, string, string, Uint8Array, string]> =
      this.#database.query(`
        INSERT INTO peer_pins(
          tenant_id, agent_id, root_key_id, public_key, verification_mode, verified_at
        ) VALUES (?, ?, ?, ?, 'organization', ?)
        ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
          root_key_id = excluded.root_key_id,
          public_key = excluded.public_key,
          verification_mode = 'organization',
          verified_at = excluded.verified_at
      `);
    for (const binding of policy.bindings) {
      upsertPin.run(
        policy.tenantId,
        binding.agentId,
        binding.rootKeyId,
        binding.rootPublicKey,
        importedAt,
      );
    }
    const deleteExpectations: Statement<unknown, [string, string]> = this.#database.query(`
      DELETE FROM peer_root_expectations WHERE tenant_id = ? AND agent_id = ?
    `);
    for (const binding of policy.bindings) {
      deleteExpectations.run(policy.tenantId, binding.agentId);
    }
  }

  public async applyPolicy(
    policy: OrganizationTrustPolicy,
    expectedIssuerKeyId: string,
    now: Date,
  ): Promise<StoredTrustPolicyState> {
    await verifyOrganizationTrustPolicy(policy, expectedIssuerKeyId, now);
    const importedAt: string = now.toISOString();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current: StoredTrustPolicyState | null = this.getPolicyState(policy.tenantId);
      const existingRevocations: ReadonlySet<string> = this.revokedRootIds(policy.tenantId);
      this.#assertUpdate(policy, current, existingRevocations);
      this.#writePolicy(policy, importedAt);
      this.#database.exec("COMMIT");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const stored: StoredTrustPolicyState | null = this.getPolicyState(policy.tenantId);
    if (stored === null) throw new Error("Organization trust policy was not stored");
    return stored;
  }
}
