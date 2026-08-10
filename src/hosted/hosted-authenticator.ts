import type { Sql } from "postgres";
import { z } from "zod";

import { PersonalId } from "../domain/orchestration.js";
import { AgentId, RepositoryName, TenantId } from "../domain/value-objects.js";
import { logSafeError } from "../safe-errors.js";
import type { CredentialAdmission, HostedPrincipal } from "./control-plane-contracts.js";
import { type AuthRowV2, AuthRowV2Schema } from "./control-plane-rows.js";
import {
  credentialAdmissionKey,
  type DatabaseCredentialHint,
  databaseCredentialHint,
  hashTokenSecret,
} from "./token-secret.js";

const CREDENTIAL_REFRESH_INTERVAL_MS: number = 5_000;
type CredentialHintRow = { readonly credential_key: string; readonly tenant_key: string | null };
const CredentialHintRowSchema: z.ZodType<CredentialHintRow> = z.strictObject({
  credential_key: z.string().regex(/^[a-f0-9]{64}$/u),
  tenant_key: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

export class HostedAuthenticator {
  private readonly admissions: Map<string, string | null>;
  private closed: boolean;
  private refreshQueue: Promise<void>;
  private refreshTimer: ReturnType<typeof setInterval> | null;
  private readonly database: Sql;

  public constructor(database: Sql) {
    this.admissions = new Map<string, string | null>();
    this.closed = false;
    this.database = database;
    this.refreshQueue = Promise.resolve();
    this.refreshTimer = null;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The hosted authenticator is closed");
  }

  private async loadAdmissions(): Promise<void> {
    const rawRows: unknown = await this.database`
      SELECT credential_key, tenant_key FROM murmur.active_credential_hints()
    `;
    const rows: CredentialHintRow[] = z.array(CredentialHintRowSchema).parse(rawRows);
    const refreshed: Map<string, string | null> = new Map<string, string | null>();
    rows.forEach((row: CredentialHintRow): void => {
      refreshed.set(row.credential_key, row.tenant_key);
    });
    this.admissions.clear();
    refreshed.forEach((tenantKey: string | null, key: string): void => {
      this.admissions.set(key, tenantKey);
    });
  }

  public refresh(): Promise<void> {
    this.ensureOpen();
    const refresh: Promise<void> = this.refreshQueue.then(
      async (): Promise<void> => await this.loadAdmissions(),
      async (): Promise<void> => await this.loadAdmissions(),
    );
    this.refreshQueue = refresh.then(
      (): void => undefined,
      (): void => undefined,
    );
    return refresh;
  }

  public async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval((): void => {
      if (this.closed) return;
      void this.refresh().catch((error: unknown): void => {
        logSafeError("Murmur credential admission refresh failed", error);
      });
    }, CREDENTIAL_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  public credentialAdmission(token: string): CredentialAdmission | null {
    const hint: DatabaseCredentialHint | null = databaseCredentialHint(token);
    if (hint === null) return null;
    const key: string = credentialAdmissionKey(token);
    const tenantKey: string | null | undefined = this.admissions.get(key);
    return tenantKey === undefined ? null : { key, tenantKey };
  }

  public async authenticate(token: string): Promise<HostedPrincipal | null> {
    this.ensureOpen();
    const credentialHash: Buffer = hashTokenSecret(token);
    const rawRows: unknown = await this.database`
      SELECT principal_kind, token_id::text AS token_id, key_id,
        tenant_id::text AS tenant_id, token_role,
        personal_id::text AS personal_id, repository_name, orchestrator_agent_id
      FROM murmur.authenticate_principal_v2(${credentialHash})
    `;
    const row: AuthRowV2 | undefined = z.array(AuthRowV2Schema).parse(rawRows)[0];
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

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    await this.refreshQueue;
  }
}
