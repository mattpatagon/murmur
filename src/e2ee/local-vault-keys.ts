import type { Changes, Database, Statement } from "bun:sqlite";
import sodium from "libsodium-wrappers";
import { z } from "zod";

import {
  type AgentKeyCertificate,
  type AgentKeyCertificateFields,
  agentSigningKeyId,
  createAgentKeyCertificate,
  createBoxKeyPair,
  createPrekeyCertificate,
  createSigningKeyPair,
  type PrekeyCertificate,
  type PrekeyCertificateFields,
  prekeyId,
  rootKeyId,
} from "./certificates.js";
import {
  mapAgentKeyRow,
  mapExpectedPeerRootRow,
  mapPeerPinRow,
  mapPrekeyRow,
  mapRootKeyRow,
  type ExpectedPeerRoot,
  type PeerPin,
  type StoredAgentKey,
  type StoredPrekey,
  type StoredRootKey,
} from "./local-vault-rows.js";
import type { BoxKeyPair, PrekeyClass, SigningKeyPair } from "./protocol.js";

const ExpectedPeerRootSchema: z.ZodType<ExpectedPeerRoot> = z.strictObject({
  agentId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  rootKeyId: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  tenantId: z.string().uuid(),
  verifiedAt: z.iso.datetime({ offset: true }),
});

function pinRank(mode: PeerPin["verificationMode"]): number {
  if (mode === "tofu") return 0;
  if (mode === "strict") return 1;
  return 2;
}

export class LocalVaultKeys {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public getRoot(): StoredRootKey | null {
    const statement: Statement<unknown, []> = this.#database.query(`
      SELECT root_key_id, public_key, private_key, created_at FROM root_keys WHERE singleton = 1
    `);
    const row: unknown = statement.get();
    return row === null ? null : mapRootKeyRow(row);
  }

  public async getOrCreateRoot(createdAt: string): Promise<StoredRootKey> {
    const existing: StoredRootKey | null = this.getRoot();
    if (existing !== null) return existing;
    const pair: SigningKeyPair = await createSigningKeyPair(null);
    const generatedId: string = await rootKeyId(pair.publicKey);
    const statement: Statement<unknown, [number, string, Uint8Array, Uint8Array, string]> =
      this.#database.query(`
        INSERT OR IGNORE INTO root_keys(
          singleton, root_key_id, public_key, private_key, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
    const result: Changes = statement.run(
      1,
      generatedId,
      pair.publicKey,
      pair.privateKey,
      createdAt,
    );
    if (result.changes === 1) {
      return {
        createdAt,
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        rootKeyId: generatedId,
      };
    }
    sodium.memzero(pair.privateKey);
    const winner: StoredRootKey | null = this.getRoot();
    if (winner === null) throw new Error("E2E root creation lost its concurrent winner");
    return winner;
  }

  public getAgent(agentId: string): StoredAgentKey | null {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT agent_id, root_key_id, signing_key_id, public_key, private_key,
             created_at, expires_at, certificate_signature
      FROM agent_keys WHERE agent_id = ?
    `);
    const row: unknown = statement.get(agentId);
    return row === null ? null : mapAgentKeyRow(row);
  }

  public async getOrCreateAgent(
    agentId: string,
    createdAt: string,
    expiresAt: string,
    minimumValidUntil: string = createdAt,
  ): Promise<StoredAgentKey> {
    const existing: StoredAgentKey | null = this.getAgent(agentId);
    const createdMillis: number = Date.parse(createdAt);
    const expiresMillis: number = Date.parse(expiresAt);
    const minimumValidMillis: number = Date.parse(minimumValidUntil);
    if (
      !Number.isFinite(createdMillis) ||
      !Number.isFinite(expiresMillis) ||
      !Number.isFinite(minimumValidMillis) ||
      minimumValidMillis < createdMillis ||
      expiresMillis <= minimumValidMillis
    ) {
      throw new Error("Agent key validity window is invalid");
    }
    if (existing !== null && Date.parse(existing.certificate.expiresAt) > minimumValidMillis) {
      return existing;
    }
    const root: StoredRootKey = await this.getOrCreateRoot(createdAt);
    const pair: SigningKeyPair = await createSigningKeyPair(null);
    const fields: AgentKeyCertificateFields = {
      agentId,
      createdAt,
      expiresAt,
      rootKeyId: root.rootKeyId,
      signingKeyId: await agentSigningKeyId(pair.publicKey),
      signingPublicKey: pair.publicKey,
    };
    const certificate: AgentKeyCertificate = await createAgentKeyCertificate(
      fields,
      root.privateKey,
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current: StoredAgentKey | null = this.getAgent(agentId);
      if (current !== null && Date.parse(current.certificate.expiresAt) > minimumValidMillis) {
        this.#database.exec("COMMIT");
        sodium.memzero(pair.privateKey);
        return current;
      }
      let result: Changes;
      if (current === null) {
        const insert: Statement<
          unknown,
          [string, string, string, Uint8Array, Uint8Array, string, string, Uint8Array]
        > = this.#database.query(`
          INSERT INTO agent_keys(
            agent_id, root_key_id, signing_key_id, public_key, private_key,
            created_at, expires_at, certificate_signature
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        result = insert.run(
          agentId,
          fields.rootKeyId,
          fields.signingKeyId,
          pair.publicKey,
          pair.privateKey,
          createdAt,
          expiresAt,
          certificate.signature,
        );
      } else {
        const rotate: Statement<
          unknown,
          [string, Uint8Array, Uint8Array, string, string, Uint8Array, string, string]
        > = this.#database.query(`
          UPDATE agent_keys SET
            signing_key_id = ?, public_key = ?, private_key = ?,
            created_at = ?, expires_at = ?, certificate_signature = ?
          WHERE agent_id = ? AND signing_key_id = ?
        `);
        result = rotate.run(
          fields.signingKeyId,
          pair.publicKey,
          pair.privateKey,
          createdAt,
          expiresAt,
          certificate.signature,
          agentId,
          current.certificate.signingKeyId,
        );
      }
      if (result.changes !== 1)
        throw new Error("E2E agent key rotation lost its current generation");
      this.#database.exec("COMMIT");
      return { certificate, privateKey: pair.privateKey };
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      sodium.memzero(pair.privateKey);
      throw error;
    }
  }

  public listPrekeys(agentId: string, prekeyClass: PrekeyClass): readonly StoredPrekey[] {
    const statement: Statement<unknown, [string, PrekeyClass]> = this.#database.query(`
      SELECT p.agent_id, p.agent_signing_key_id,
             p.prekey_id, p.prekey_class, p.public_key, p.private_key,
             p.created_at, p.expires_at, p.consumed_at, p.certificate_signature
      FROM prekeys p
      JOIN agent_keys a ON a.agent_id = p.agent_id
      WHERE p.agent_id = ? AND p.prekey_class = ?
      ORDER BY p.created_at, p.prekey_id
    `);
    return statement.all(agentId, prekeyClass).map(mapPrekeyRow);
  }

  public getPrekey(prekeyIdValue: string): StoredPrekey | null {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT p.agent_id, p.agent_signing_key_id,
             p.prekey_id, p.prekey_class, p.public_key, p.private_key,
             p.created_at, p.expires_at, p.consumed_at, p.certificate_signature
      FROM prekeys p
      JOIN agent_keys a ON a.agent_id = p.agent_id
      WHERE p.prekey_id = ?
    `);
    const row: unknown = statement.get(prekeyIdValue);
    return row === null ? null : mapPrekeyRow(row);
  }

  public async replenishPrekeys(
    agentId: string,
    prekeyClass: PrekeyClass,
    count: number,
    createdAt: string,
    expiresAt: string,
  ): Promise<readonly StoredPrekey[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error("Prekey replenishment count must be between 1 and 100");
    }
    const agent: StoredAgentKey = await this.getOrCreateAgent(agentId, createdAt, expiresAt);
    const generated: StoredPrekey[] = [];
    for (let index: number = 0; index < count; index += 1) {
      const pair: BoxKeyPair = await createBoxKeyPair(null);
      const fields: PrekeyCertificateFields = {
        agentId,
        agentSigningKeyId: agent.certificate.signingKeyId,
        createdAt,
        expiresAt,
        prekeyClass,
        prekeyId: await prekeyId(pair.publicKey),
        prekeyPublicKey: pair.publicKey,
      };
      const certificate: PrekeyCertificate = await createPrekeyCertificate(
        fields,
        agent.privateKey,
      );
      generated.push({ certificate, consumedAt: null, privateKey: pair.privateKey });
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const insert: Statement<
        unknown,
        [string, string, string, PrekeyClass, Uint8Array, Uint8Array, string, string, Uint8Array]
      > = this.#database.query(`
        INSERT INTO prekeys(
          prekey_id, agent_id, agent_signing_key_id, prekey_class, public_key, private_key,
          created_at, expires_at, certificate_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      generated.forEach((item: StoredPrekey): void => {
        const privateKey: Uint8Array | null = item.privateKey;
        if (privateKey === null) throw new Error("Generated prekey lost its private key");
        insert.run(
          item.certificate.prekeyId,
          agentId,
          agent.certificate.signingKeyId,
          prekeyClass,
          item.certificate.prekeyPublicKey,
          privateKey,
          createdAt,
          expiresAt,
          item.certificate.signature,
        );
      });
      this.#database.exec("COMMIT");
      return generated;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      generated.forEach((item: StoredPrekey): void => {
        if (item.privateKey !== null) sodium.memzero(item.privateKey);
      });
      throw error;
    }
  }

  public purgeExpiredPrivatePrekeys(now: string): number {
    const statement: Statement<unknown, [string]> = this.#database.query(`
      UPDATE prekeys SET private_key = NULL
      WHERE expires_at <= ? AND private_key IS NOT NULL
    `);
    return statement.run(now).changes;
  }

  public getPin(tenantId: string, agentId: string): PeerPin | null {
    const statement: Statement<unknown, [string, string]> = this.#database.query(`
      SELECT tenant_id, agent_id, root_key_id, public_key, verification_mode, verified_at
      FROM peer_pins WHERE tenant_id = ? AND agent_id = ?
    `);
    const row: unknown = statement.get(tenantId, agentId);
    return row === null ? null : mapPeerPinRow(row);
  }

  public listPins(): readonly PeerPin[] {
    const statement: Statement<unknown, []> = this.#database.query(`
      SELECT tenant_id, agent_id, root_key_id, public_key, verification_mode, verified_at
      FROM peer_pins ORDER BY tenant_id, agent_id LIMIT 10001
    `);
    const pins: readonly PeerPin[] = statement.all().map(mapPeerPinRow);
    if (pins.length > 10_000) throw new Error("Local peer pin limit exceeded");
    return pins;
  }

  public getExpectedPeerRoot(tenantId: string, agentId: string): ExpectedPeerRoot | null {
    const statement: Statement<unknown, [string, string]> = this.#database.query(`
      SELECT tenant_id, agent_id, root_key_id, verified_at
      FROM peer_root_expectations WHERE tenant_id = ? AND agent_id = ?
    `);
    const row: unknown = statement.get(tenantId, agentId);
    return row === null ? null : mapExpectedPeerRootRow(row);
  }

  public listExpectedPeerRoots(): readonly ExpectedPeerRoot[] {
    const statement: Statement<unknown, []> = this.#database.query(`
      SELECT tenant_id, agent_id, root_key_id, verified_at
      FROM peer_root_expectations ORDER BY tenant_id, agent_id LIMIT 10001
    `);
    const roots: readonly ExpectedPeerRoot[] = statement.all().map(mapExpectedPeerRootRow);
    if (roots.length > 10_000) throw new Error("Local peer expectation limit exceeded");
    return roots;
  }

  public expectPeerRoot(input: ExpectedPeerRoot): ExpectedPeerRoot {
    const expected: ExpectedPeerRoot = ExpectedPeerRootSchema.parse(input);
    const existingPin: PeerPin | null = this.getPin(expected.tenantId, expected.agentId);
    if (existingPin !== null) {
      if (existingPin.rootKeyId !== expected.rootKeyId) {
        throw new Error("Peer root changed and requires an audited reset");
      }
      return expected;
    }
    const existing: ExpectedPeerRoot | null = this.getExpectedPeerRoot(
      expected.tenantId,
      expected.agentId,
    );
    if (existing !== null && existing.rootKeyId !== expected.rootKeyId) {
      throw new Error("Peer root expectation changed and requires an audited reset");
    }
    const statement: Statement<unknown, [string, string, string, string]> = this.#database.query(`
      INSERT INTO peer_root_expectations(tenant_id, agent_id, root_key_id, verified_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, agent_id) DO UPDATE SET verified_at = excluded.verified_at
    `);
    statement.run(expected.tenantId, expected.agentId, expected.rootKeyId, expected.verifiedAt);
    const stored: ExpectedPeerRoot | null = this.getExpectedPeerRoot(
      expected.tenantId,
      expected.agentId,
    );
    if (stored === null) throw new Error("Peer root expectation was not stored");
    return stored;
  }

  public getUsablePin(tenantId: string, agentId: string, now: Date): PeerPin | null {
    const pin: PeerPin | null = this.getPin(tenantId, agentId);
    if (pin === null || pin.verificationMode !== "organization") return pin;
    const statement: Statement<unknown, [string]> = this.#database.query(`
      SELECT expires_at FROM trust_policy_state WHERE tenant_id = ?
    `);
    const row: unknown = statement.get(tenantId);
    const parsed: { readonly expires_at: string } = z
      .strictObject({ expires_at: z.string() })
      .parse(row);
    const expiresMillis: number = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresMillis) || now.getTime() >= expiresMillis) {
      throw new Error("Organization trust policy is expired; import a valid update");
    }
    return pin;
  }

  public async pinPeer(pin: PeerPin): Promise<PeerPin> {
    await sodium.ready;
    const derivedId: string = await rootKeyId(pin.publicKey);
    if (derivedId !== pin.rootKeyId)
      throw new Error("Peer root fingerprint does not match its key");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const revokedStatement: Statement<unknown, [string, string]> = this.#database.query(`
        SELECT 1 FROM trust_policy_revocations WHERE tenant_id = ? AND root_key_id = ?
      `);
      if (revokedStatement.get(pin.tenantId, pin.rootKeyId) !== null) {
        throw new Error("Peer root is revoked by the organization trust policy");
      }
      const existing: PeerPin | null = this.getPin(pin.tenantId, pin.agentId);
      const expected: ExpectedPeerRoot | null = this.getExpectedPeerRoot(pin.tenantId, pin.agentId);
      if (expected !== null && expected.rootKeyId !== pin.rootKeyId) {
        throw new Error("Peer root does not match its verified expectation");
      }
      if (existing !== null) {
        if (
          existing.rootKeyId !== pin.rootKeyId ||
          !sodium.memcmp(existing.publicKey, pin.publicKey)
        ) {
          throw new Error("Peer root changed and requires an audited reset");
        }
        if (pinRank(pin.verificationMode) < pinRank(existing.verificationMode)) {
          throw new Error("Peer verification mode cannot be downgraded");
        }
      }
      const statement: Statement<unknown, [string, string, string, Uint8Array, string, string]> =
        this.#database.query(`
          INSERT INTO peer_pins(
            tenant_id, agent_id, root_key_id, public_key, verification_mode, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
            verification_mode = excluded.verification_mode,
            verified_at = excluded.verified_at
        `);
      statement.run(
        pin.tenantId,
        pin.agentId,
        pin.rootKeyId,
        pin.publicKey,
        pin.verificationMode,
        pin.verifiedAt,
      );
      const clearExpectation: Statement<unknown, [string, string]> = this.#database.query(`
        DELETE FROM peer_root_expectations WHERE tenant_id = ? AND agent_id = ?
      `);
      clearExpectation.run(pin.tenantId, pin.agentId);
      this.#database.exec("COMMIT");
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const stored: PeerPin | null = this.getPin(pin.tenantId, pin.agentId);
    if (stored === null) throw new Error("Peer pin was not stored");
    return stored;
  }
}
