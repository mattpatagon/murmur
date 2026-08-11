import type { Database } from "bun:sqlite";

import {
  type AgentKeyRevocation,
  createAgentKeyRevocation,
  verifyAgentKeyRevocation,
} from "./certificates.js";
import {
  mapAgentKeyRevocationRow,
  mapAgentKeyRow,
  type StoredAgentKey,
  type StoredRootKey,
} from "./local-vault-rows.js";

export function listLocalAgentKeyRevocations(
  database: Database,
  agentId: string,
): readonly AgentKeyRevocation[] {
  const revocations: readonly AgentKeyRevocation[] = database
    .query<unknown, [string]>(`
      SELECT agent_id, revoked_signing_key_id, root_key_id, revoked_at, reason, signature
      FROM agent_key_revocations
      WHERE agent_id = ?
      ORDER BY revoked_signing_key_id
      LIMIT 101
    `)
    .all(agentId)
    .map(mapAgentKeyRevocationRow);
  if (revocations.length > 100) throw new Error("Local E2E agent revocation limit exceeded");
  return revocations;
}

export function isLocalAgentKeyRevoked(
  database: Database,
  agentId: string,
  signingKeyId: string,
): boolean {
  return (
    database
      .query<unknown, [string, string]>(`
        SELECT 1 FROM agent_key_revocations
        WHERE agent_id = ? AND revoked_signing_key_id = ?
      `)
      .get(agentId, signingKeyId) !== null
  );
}

function currentAgent(database: Database, agentId: string): StoredAgentKey | null {
  const row: unknown = database
    .query<unknown, [string]>(`
      SELECT agent_id, root_key_id, signing_key_id, public_key, private_key,
             created_at, expires_at, certificate_signature
      FROM agent_keys WHERE agent_id = ?
    `)
    .get(agentId);
  return row === null ? null : mapAgentKeyRow(row);
}

export async function revokeLocalCurrentAgentKey(
  database: Database,
  agentId: string,
  reason: string,
  revokedAt: string,
  agent: StoredAgentKey | null,
  root: StoredRootKey | null,
): Promise<AgentKeyRevocation> {
  if (agent === null || root === null) {
    throw new Error("The local E2E agent key is not initialized; use an encrypted tool first");
  }
  const existing: readonly AgentKeyRevocation[] = listLocalAgentKeyRevocations(database, agentId);
  if (existing.length >= 100) throw new Error("Local E2E agent revocation limit exceeded");
  const prior: AgentKeyRevocation | undefined = existing.find(
    (revocation: AgentKeyRevocation): boolean =>
      revocation.revokedSigningKeyId === agent.certificate.signingKeyId,
  );
  if (prior !== undefined) return prior;
  const revocation: AgentKeyRevocation = await createAgentKeyRevocation(
    {
      agentId,
      reason,
      revokedAt,
      revokedSigningKeyId: agent.certificate.signingKeyId,
      rootKeyId: root.rootKeyId,
    },
    root.privateKey,
  );
  await verifyAgentKeyRevocation(revocation, root.publicKey, agentId, new Date(revokedAt));
  database.exec("BEGIN IMMEDIATE");
  try {
    const current: StoredAgentKey | null = currentAgent(database, agentId);
    if (current === null || current.certificate.signingKeyId !== agent.certificate.signingKeyId) {
      throw new Error("E2E agent key changed during revocation");
    }
    database
      .query<unknown, [string, string, string, string, string, Uint8Array]>(`
        INSERT INTO agent_key_revocations(
          agent_id, revoked_signing_key_id, root_key_id, revoked_at, reason, signature
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        agentId,
        revocation.revokedSigningKeyId,
        revocation.rootKeyId,
        revocation.revokedAt,
        revocation.reason,
        revocation.signature,
      );
    database
      .query<unknown, [string, string]>(`
        UPDATE prekeys SET private_key = NULL
        WHERE agent_id = ? AND agent_signing_key_id = ? AND private_key IS NOT NULL
      `)
      .run(agentId, revocation.revokedSigningKeyId);
    database.exec("COMMIT");
    return revocation;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}
