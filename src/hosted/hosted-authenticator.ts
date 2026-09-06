import type { Sql } from "postgres";
import { z } from "zod";

import { PersonalId } from "../domain/orchestration.js";
import { AgentId, RepositoryName, TenantId } from "../domain/value-objects.js";
import type { CredentialAdmission, HostedPrincipal } from "./control-plane-contracts.js";
import { type AuthRowV2, AuthRowV2Schema } from "./control-plane-rows.js";
import { CredentialAdmissionCache } from "./credential-admission-cache.js";
import {
  credentialAdmissionKey,
  type DatabaseCredentialHint,
  databaseCredentialHint,
  hashTokenSecret,
} from "./token-secret.js";

const AuthRowsV2Schema: z.ZodType<AuthRowV2[]> = z.array(AuthRowV2Schema).max(1);

export class HostedAuthenticator {
  private readonly admissions: CredentialAdmissionCache;
  private closed: boolean;
  private readonly database: Sql;

  public constructor(
    database: Sql,
    admissions: CredentialAdmissionCache = new CredentialAdmissionCache(),
  ) {
    this.admissions = admissions;
    this.closed = false;
    this.database = database;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The hosted authenticator is closed");
  }

  public refresh(): Promise<void> {
    this.ensureOpen();
    // Token management cannot flush unrelated tenants' admission priority.
    return Promise.resolve();
  }

  public start(): Promise<void> {
    this.ensureOpen();
    return Promise.resolve();
  }

  public credentialAdmission(token: string): CredentialAdmission | null {
    if (this.closed) return null;
    const hint: DatabaseCredentialHint | null = databaseCredentialHint(token);
    if (hint === null) return null;
    return this.admissions.get(credentialAdmissionKey(token));
  }

  public async authenticate(token: string): Promise<HostedPrincipal | null> {
    this.ensureOpen();
    const key: string = credentialAdmissionKey(token);
    const credentialHash: Buffer = hashTokenSecret(token);
    let principal: HostedPrincipal | null;
    try {
      principal = await this.authenticatePrincipal(credentialHash);
    } catch (error: unknown) {
      this.admissions.forget(key);
      throw error;
    }
    if (principal === null) this.admissions.forget(key);
    else if (!this.closed) {
      this.admissions.remember({
        key,
        tenantKey:
          principal.kind === "tenant" ? credentialAdmissionKey(principal.tenantId.value) : null,
      });
    }
    return principal;
  }

  private async authenticatePrincipal(credentialHash: Buffer): Promise<HostedPrincipal | null> {
    const rawRows: unknown = await this.database`
      SELECT principal_kind, token_id::text AS token_id, key_id,
        tenant_id::text AS tenant_id, token_role,
        personal_id::text AS personal_id, repository_name, orchestrator_agent_id
      FROM murmur.authenticate_principal_v2(${credentialHash})
    `;
    const row: AuthRowV2 | undefined = AuthRowsV2Schema.parse(rawRows)[0];
    if (row === undefined) return null;
    if (row.principal_kind === "bootstrap") {
      if (
        row.tenant_id !== null ||
        row.token_role !== null ||
        row.personal_id !== null ||
        row.repository_name !== null ||
        row.orchestrator_agent_id !== null
      ) {
        throw new Error("Bootstrap authentication returned tenant fields");
      }
      return { keyId: row.key_id, kind: "bootstrap", tokenId: row.token_id };
    }
    if (row.principal_kind === "operator") {
      if (
        row.tenant_id !== null ||
        row.token_role !== null ||
        row.personal_id !== null ||
        row.repository_name !== null ||
        row.orchestrator_agent_id !== null
      ) {
        throw new Error("Operator authentication returned tenant fields");
      }
      return { credentialHash, keyId: row.key_id, kind: "operator", tokenId: row.token_id };
    }
    if (row.tenant_id === null || row.token_role === null || row.personal_id === null) {
      throw new Error("Tenant authentication omitted tenant fields");
    }
    if (
      (row.token_role === "orchestrator" && row.orchestrator_agent_id === null) ||
      (row.token_role !== "orchestrator" && row.orchestrator_agent_id !== null)
    ) {
      throw new Error("Tenant authentication returned an invalid agent binding");
    }
    return {
      agentId: row.orchestrator_agent_id === null ? null : AgentId.parse(row.orchestrator_agent_id),
      kind: "tenant",
      personalId: PersonalId.parse(row.personal_id),
      repositoryName:
        row.repository_name === null ? null : RepositoryName.parse(row.repository_name),
      role: row.token_role,
      tenantId: TenantId.parse(row.tenant_id),
      tokenId: row.token_id,
    };
  }

  public close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.admissions.clear();
    return Promise.resolve();
  }
}
