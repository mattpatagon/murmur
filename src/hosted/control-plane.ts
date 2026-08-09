import { randomUUID } from "node:crypto";

import postgres, { type Sql, type TransactionSql } from "postgres";
import { z } from "zod";

import { Instant, JsonObjectSchema, TenantId, type JsonObject } from "../domain/value-objects.js";
import {
  postgresSslOptions,
  type PostgresSslOptions,
  type PostgresTlsConfiguration,
} from "../postgres-tls.js";
import { logSafeError } from "../safe-errors.js";
import {
  credentialAdmissionKey,
  databaseCredentialHint,
  generateTokenSecret,
  hashTokenSecret,
  parseOperatorTokenSecret,
  type DatabaseCredentialHint,
  type HostedTokenPrefix,
  type HostedTokenSecret,
} from "./token-secret.js";

export type TenantTokenRole = "agent" | "tenant_admin";
export type TenantStatus = "active" | "suspended";

export type TenantPrincipal = {
  readonly kind: "tenant";
  readonly role: TenantTokenRole;
  readonly tenantId: TenantId;
  readonly tokenId: string;
};

export type OperatorPrincipal = {
  readonly credentialHash: Buffer;
  readonly keyId: string;
  readonly kind: "operator";
  readonly tokenId: string;
};

export type BootstrapPrincipal = {
  readonly keyId: string;
  readonly kind: "bootstrap";
  readonly tokenId: string;
};

export type HostedPrincipal = BootstrapPrincipal | OperatorPrincipal | TenantPrincipal;

export type CredentialAdmission = {
  readonly key: string;
  readonly tenantKey: string | null;
};

export type IssuedToken = {
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly name: string;
  readonly role: TenantTokenRole;
  readonly secret: string;
  readonly tenantId: TenantId;
  readonly tokenId: string;
};

export type IssuedOperatorToken = {
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly name: string;
  readonly secret: string;
  readonly tokenId: string;
};

export type TokenSummary = {
  readonly createdAt: Instant;
  readonly expiresAt: Instant | null;
  readonly keyId: string;
  readonly lastUsedAt: Instant | null;
  readonly name: string;
  readonly revokedAt: Instant | null;
  readonly role: TenantTokenRole;
  readonly tokenId: string;
};

export type OperatorTokenSummary = Omit<TokenSummary, "role">;

export type TenantSummary = {
  readonly createdAt: Instant;
  readonly displayName: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly suspendedAt: Instant | null;
  readonly tenantId: TenantId;
};

export type AdminAuditEvent = {
  readonly action: string;
  readonly actorKeyId: string;
  readonly actorTokenId: string;
  readonly auditId: number;
  readonly createdAt: Instant;
  readonly metadata: JsonObject;
  readonly targetId: string;
  readonly targetKind: string;
};

export type Page<T> = {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export interface HostedControlPlane {
  authenticate(token: string): Promise<HostedPrincipal | null>;
  bootstrapOperatorToken(
    bootstrapCredentialHash: Buffer,
    name: string,
    secret: string,
  ): Promise<IssuedOperatorToken>;
  adoptLegacyFoundingToken(
    principal: OperatorPrincipal,
    legacyCredentialHash: Buffer,
  ): Promise<boolean>;
  close(): Promise<void>;
  credentialAdmission(token: string): CredentialAdmission | null;
  createOperatorToken(
    principal: OperatorPrincipal,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedOperatorToken>;
  createTenant(
    principal: OperatorPrincipal,
    slug: string,
    displayName: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }>;
  createToken(
    tenantId: TenantId,
    role: TenantTokenRole,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken>;
  hasActiveOperator(): Promise<boolean>;
  listAdminAudit(principal: OperatorPrincipal, limit: number): Promise<readonly AdminAuditEvent[]>;
  listOperatorTokens(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OperatorTokenSummary>>;
  listTenants(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TenantSummary>>;
  listTokens(tenantId: TenantId, cursor: string | null, limit: number): Promise<Page<TokenSummary>>;
  mintTenantAdminToken(
    principal: OperatorPrincipal,
    tenantId: TenantId,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken>;
  restoreTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  revokeOperatorToken(principal: OperatorPrincipal, keyId: string): Promise<string | null>;
  revokeToken(tenantId: TenantId, keyId: string): Promise<string | null>;
  suspendTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean>;
  tenantOnboardingEnabled(): Promise<boolean>;
}

type AuthRow = {
  readonly key_id: string;
  readonly principal_kind: "bootstrap" | "operator" | "tenant";
  readonly tenant_id: string | null;
  readonly token_id: string;
  readonly token_role: TenantTokenRole | null;
};

type TokenRow = {
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly key_id: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly token_id: string;
  readonly token_role: TenantTokenRole;
};

type OperatorTokenRow = Omit<TokenRow, "token_role">;

type TenantRow = {
  readonly created_at: string;
  readonly display_name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly suspended_at: string | null;
  readonly tenant_id: string;
};

type AuditRow = {
  readonly action: string;
  readonly actor_key_id: string;
  readonly actor_token_id: string;
  readonly audit_id: number;
  readonly created_at: string;
  readonly metadata: JsonObject;
  readonly target_id: string;
  readonly target_kind: string;
};

type BooleanRow = { readonly changed: boolean };
type CredentialHintRow = {
  readonly credential_key: string;
  readonly tenant_key: string | null;
};
type HostedSchemaProbeRow = BooleanRow & {
  readonly bypasses_rls: boolean;
  readonly current_role: string;
  readonly is_superuser: boolean;
};
type NullableTokenIdRow = { readonly token_id: string | null };
type TokenIdRow = { readonly token_id: string };

export type HostedTlsConfiguration = PostgresTlsConfiguration;

const AuthRowSchema: z.ZodType<AuthRow> = z.strictObject({
  key_id: z.string(),
  principal_kind: z.enum(["bootstrap", "operator", "tenant"]),
  tenant_id: z.string().uuid().nullable(),
  token_id: z.string().uuid(),
  token_role: z.enum(["agent", "tenant_admin"]).nullable(),
});

const OperatorTokenRowSchema: z.ZodType<OperatorTokenRow> = z.strictObject({
  created_at: z.string(),
  expires_at: z.string().nullable(),
  key_id: z.string(),
  last_used_at: z.string().nullable(),
  name: z.string(),
  revoked_at: z.string().nullable(),
  token_id: z.string().uuid(),
});

const TokenRowSchema: z.ZodType<TokenRow> = z.strictObject({
  created_at: z.string(),
  expires_at: z.string().nullable(),
  key_id: z.string(),
  last_used_at: z.string().nullable(),
  name: z.string(),
  revoked_at: z.string().nullable(),
  token_id: z.string().uuid(),
  token_role: z.enum(["agent", "tenant_admin"]),
});

const TenantRowSchema: z.ZodType<TenantRow> = z.strictObject({
  created_at: z.string(),
  display_name: z.string(),
  slug: z.string(),
  status: z.enum(["active", "suspended"]),
  suspended_at: z.string().nullable(),
  tenant_id: z.string().uuid(),
});

const AuditRowSchema: z.ZodType<AuditRow> = z.strictObject({
  action: z.string(),
  actor_key_id: z.string(),
  actor_token_id: z.string().uuid(),
  audit_id: z.coerce.number().int().positive(),
  created_at: z.string(),
  metadata: JsonObjectSchema,
  target_id: z.string(),
  target_kind: z.string(),
});

const BooleanRowSchema: z.ZodType<BooleanRow> = z.strictObject({
  changed: z.boolean(),
});
const CredentialHintRowSchema: z.ZodType<CredentialHintRow> = z.strictObject({
  credential_key: z.string().regex(/^[a-f0-9]{64}$/u),
  tenant_key: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});
const HostedSchemaProbeRowSchema: z.ZodType<HostedSchemaProbeRow> = z.strictObject({
  bypasses_rls: z.boolean(),
  changed: z.boolean(),
  current_role: z.string(),
  is_superuser: z.boolean(),
});
const NullableTokenIdRowSchema: z.ZodType<NullableTokenIdRow> = z.strictObject({
  token_id: z.string().uuid().nullable(),
});
const TokenIdRowSchema: z.ZodType<TokenIdRow> = z.strictObject({
  token_id: z.string().uuid(),
});

function issueSecret(prefix: HostedTokenPrefix): {
  readonly hash: Buffer;
  readonly keyId: string;
  readonly secret: string;
  readonly tokenId: string;
} {
  return { ...generateTokenSecret(prefix), tokenId: randomUUID() };
}

function issueToken(
  tenantId: TenantId,
  role: TenantTokenRole,
  name: string,
  expiresAt: Instant | null,
): { readonly hash: Buffer; readonly token: IssuedToken } {
  const issued: ReturnType<typeof issueSecret> = issueSecret("mur");
  return {
    hash: issued.hash,
    token: {
      expiresAt,
      keyId: issued.keyId,
      name,
      role,
      secret: issued.secret,
      tenantId,
      tokenId: issued.tokenId,
    },
  };
}

function issueOperatorToken(
  name: string,
  expiresAt: Instant | null,
): { readonly hash: Buffer; readonly token: IssuedOperatorToken } {
  const issued: ReturnType<typeof issueSecret> = issueSecret("mur_op");
  return {
    hash: issued.hash,
    token: {
      expiresAt,
      keyId: issued.keyId,
      name,
      secret: issued.secret,
      tokenId: issued.tokenId,
    },
  };
}

function providedOperatorToken(
  name: string,
  secret: string,
): {
  readonly hash: Buffer;
  readonly token: IssuedOperatorToken;
} {
  const parsed: HostedTokenSecret = parseOperatorTokenSecret(secret);
  return {
    hash: parsed.hash,
    token: {
      expiresAt: null,
      keyId: parsed.keyId,
      name,
      secret,
      tokenId: randomUUID(),
    },
  };
}

function mapOperatorToken(row: OperatorTokenRow): OperatorTokenSummary {
  return {
    createdAt: Instant.parse(row.created_at),
    expiresAt: row.expires_at === null ? null : Instant.parse(row.expires_at),
    keyId: row.key_id,
    lastUsedAt: row.last_used_at === null ? null : Instant.parse(row.last_used_at),
    name: row.name,
    revokedAt: row.revoked_at === null ? null : Instant.parse(row.revoked_at),
    tokenId: row.token_id,
  };
}

function mapToken(row: TokenRow): TokenSummary {
  return { ...mapOperatorToken(row), role: row.token_role };
}

function mapTenant(row: TenantRow): TenantSummary {
  return {
    createdAt: Instant.parse(row.created_at),
    displayName: row.display_name,
    slug: row.slug,
    status: row.status,
    suspendedAt: row.suspended_at === null ? null : Instant.parse(row.suspended_at),
    tenantId: TenantId.parse(row.tenant_id),
  };
}

function onlyRow<T>(rows: readonly T[], name: string): T {
  const row: T | undefined = rows[0];
  if (row === undefined) throw new Error(`${name} returned no row`);
  return row;
}

function page<T>(items: readonly T[], limit: number, cursorFor: (item: T) => string): Page<T> {
  if (items.length <= limit) return { items, nextCursor: null };
  const visible: readonly T[] = items.slice(0, limit);
  const last: T | undefined = visible.at(-1);
  if (last === undefined) return { items: visible, nextCursor: null };
  return { items: visible, nextCursor: cursorFor(last) };
}

export class PostgresHostedControlPlane implements HostedControlPlane {
  private readonly credentialAdmissions: Map<string, string | null>;
  private credentialRefreshQueue: Promise<void>;
  private credentialRefreshTimer: ReturnType<typeof setInterval> | null;
  private readonly database: Sql;
  private closed: boolean;

  private constructor(database: Sql) {
    this.closed = false;
    this.credentialAdmissions = new Map<string, string | null>();
    this.credentialRefreshQueue = Promise.resolve();
    this.credentialRefreshTimer = null;
    this.database = database;
  }

  public static async connect(
    databaseUrl: string,
    tlsConfiguration: HostedTlsConfiguration,
  ): Promise<PostgresHostedControlPlane> {
    const ssl: PostgresSslOptions = postgresSslOptions(databaseUrl, tlsConfiguration);
    const database: Sql = postgres(databaseUrl, {
      connect_timeout: 10,
      max: 4,
      ssl,
    });
    const controlPlane: PostgresHostedControlPlane = new PostgresHostedControlPlane(database);
    try {
      await controlPlane.ensureSchema();
      await controlPlane.refreshCredentialAdmissions();
      controlPlane.startCredentialRefresh();
      return controlPlane;
    } catch (error: unknown) {
      await database.end({ timeout: 1 });
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("The hosted control plane is closed");
  }

  private async loadCredentialAdmissions(): Promise<void> {
    const rawRows: unknown = await this.database`
      SELECT credential_key, tenant_key
      FROM murmur.active_credential_hints()
    `;
    const rows: CredentialHintRow[] = z.array(CredentialHintRowSchema).parse(rawRows);
    const refreshed: Map<string, string | null> = new Map<string, string | null>();
    rows.forEach((row: CredentialHintRow): void => {
      refreshed.set(row.credential_key, row.tenant_key);
    });
    this.credentialAdmissions.clear();
    refreshed.forEach((tenantKey: string | null, key: string): void => {
      this.credentialAdmissions.set(key, tenantKey);
    });
  }

  private refreshCredentialAdmissions(): Promise<void> {
    const refresh: Promise<void> = this.credentialRefreshQueue.then(
      async (): Promise<void> => await this.loadCredentialAdmissions(),
      async (): Promise<void> => await this.loadCredentialAdmissions(),
    );
    this.credentialRefreshQueue = refresh.then(
      (): void => undefined,
      (): void => undefined,
    );
    return refresh;
  }

  private startCredentialRefresh(): void {
    this.credentialRefreshTimer = setInterval((): void => {
      if (this.closed) return;
      void this.refreshCredentialAdmissions().catch((error: unknown): void => {
        logSafeError("Murmur credential admission refresh failed", error);
      });
    }, 5_000);
    this.credentialRefreshTimer.unref();
  }

  public credentialAdmission(token: string): CredentialAdmission | null {
    const hint: DatabaseCredentialHint | null = databaseCredentialHint(token);
    if (hint === null) return null;
    const key: string = credentialAdmissionKey(token);
    const tenantKey: string | null | undefined = this.credentialAdmissions.get(key);
    return tenantKey === undefined ? null : { key, tenantKey };
  }

  private async ensureSchema(): Promise<void> {
    const rawRows: unknown = await this.database`
      SELECT
        to_regprocedure('murmur.authenticate_principal(bytea)') IS NOT NULL
        AND to_regprocedure('murmur.active_credential_hints()') IS NOT NULL
        AND to_regclass('murmur.operator_tokens') IS NOT NULL AS changed,
        current_user AS current_role,
        role.rolsuper AS is_superuser,
        role.rolbypassrls AS bypasses_rls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = current_user
    `;
    const rows: HostedSchemaProbeRow[] = z.array(HostedSchemaProbeRowSchema).parse(rawRows);
    const row: HostedSchemaProbeRow = onlyRow(rows, "hosted schema probe");
    if (!row.changed) {
      throw new Error("Murmur's hosted tenant migration has not been applied");
    }
    if (row.current_role !== "murmur_app" || row.is_superuser || row.bypasses_rls) {
      throw new Error("Hosted Murmur must connect as the non-owner murmur_app runtime role");
    }
  }

  private async setTenantContext(transaction: TransactionSql, tenantId: TenantId): Promise<void> {
    await transaction`
      SELECT pg_catalog.set_config('murmur.tenant_id', ${tenantId.value}, true)
    `;
  }

  public async authenticate(token: string): Promise<HostedPrincipal | null> {
    this.ensureOpen();
    const credentialHash: Buffer = hashTokenSecret(token);
    const rawRows: unknown = await this.database`
      SELECT
        principal_kind,
        token_id::text AS token_id,
        key_id,
        tenant_id::text AS tenant_id,
        token_role
      FROM murmur.authenticate_principal(${credentialHash})
    `;
    const row: AuthRow | undefined = z.array(AuthRowSchema).parse(rawRows)[0];
    if (row === undefined) return null;
    if (row.principal_kind === "bootstrap") {
      if (row.tenant_id !== null || row.token_role !== null) {
        throw new Error("Bootstrap authentication returned tenant fields");
      }
      return { keyId: row.key_id, kind: "bootstrap", tokenId: row.token_id };
    }
    if (row.principal_kind === "operator") {
      if (row.tenant_id !== null || row.token_role !== null) {
        throw new Error("Operator authentication returned tenant fields");
      }
      return {
        credentialHash,
        keyId: row.key_id,
        kind: "operator",
        tokenId: row.token_id,
      };
    }
    if (row.tenant_id === null || row.token_role === null) {
      throw new Error("Tenant authentication omitted tenant fields");
    }
    return {
      kind: "tenant",
      role: row.token_role,
      tenantId: TenantId.parse(row.tenant_id),
      tokenId: row.token_id,
    };
  }

  public async hasActiveOperator(): Promise<boolean> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT murmur.operator_has_active_token() AS changed
    `;
    return onlyRow(z.array(BooleanRowSchema).parse(rawRows), "operator availability").changed;
  }

  public async tenantOnboardingEnabled(): Promise<boolean> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT murmur.tenant_onboarding_enabled() AS changed
    `;
    return onlyRow(z.array(BooleanRowSchema).parse(rawRows), "tenant onboarding capability")
      .changed;
  }

  public async bootstrapOperatorToken(
    bootstrapCredentialHash: Buffer,
    name: string,
    secret: string,
  ): Promise<IssuedOperatorToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof providedOperatorToken> = providedOperatorToken(name, secret);
    await this.database`
      SELECT murmur.operator_bootstrap(
        ${bootstrapCredentialHash},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${name}
      )
    `;
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  public async adoptLegacyFoundingToken(
    principal: OperatorPrincipal,
    legacyCredentialHash: Buffer,
  ): Promise<boolean> {
    this.ensureOpen();
    const keyId: string = `legacy_${legacyCredentialHash.toString("base64url").slice(0, 12)}`;
    const rawRows: unknown = await this.database`
      SELECT murmur.operator_adopt_legacy_founding_token(
        ${principal.credentialHash},
        ${randomUUID()}::uuid,
        ${keyId},
        ${legacyCredentialHash}
      ) AS changed
    `;
    const changed: boolean = onlyRow(
      z.array(BooleanRowSchema).parse(rawRows),
      "adopt legacy founding token",
    ).changed;
    await this.refreshCredentialAdmissions();
    return changed;
  }

  public async createOperatorToken(
    principal: OperatorPrincipal,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedOperatorToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof issueOperatorToken> = issueOperatorToken(name, expiresAt);
    await this.database`
      SELECT murmur.operator_create_operator_token(
        ${principal.credentialHash},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${name},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz
      )
    `;
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  public async listOperatorTokens(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<OperatorTokenSummary>> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT
        token_id::text AS token_id,
        key_id,
        name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN expires_at IS NULL THEN NULL ELSE
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS expires_at,
        CASE WHEN revoked_at IS NULL THEN NULL ELSE
          to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS revoked_at,
        CASE WHEN last_used_at IS NULL THEN NULL ELSE
          to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS last_used_at
      FROM murmur.operator_list_operator_tokens(
        ${principal.credentialHash},
        ${cursor}::uuid,
        ${limit + 1}
      )
    `;
    const items: readonly OperatorTokenSummary[] = z
      .array(OperatorTokenRowSchema)
      .parse(rawRows)
      .map(mapOperatorToken);
    return page(items, limit, (item: OperatorTokenSummary): string => item.tokenId);
  }

  public async revokeOperatorToken(
    principal: OperatorPrincipal,
    keyId: string,
  ): Promise<string | null> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT murmur.operator_revoke_operator_token(
        ${principal.credentialHash}, ${keyId}
      )::text AS token_id
    `;
    const tokenId: string | null = onlyRow(
      z.array(NullableTokenIdRowSchema).parse(rawRows),
      "revoke operator token",
    ).token_id;
    await this.refreshCredentialAdmissions();
    return tokenId;
  }

  public async createToken(
    tenantId: TenantId,
    role: TenantTokenRole,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof issueToken> = issueToken(tenantId, role, name, expiresAt);
    await this.database.begin(async (transaction: TransactionSql): Promise<void> => {
      await this.setTenantContext(transaction, tenantId);
      await transaction`
        DELETE FROM murmur.access_tokens
        WHERE tenant_id = ${tenantId.value}::uuid
          AND (
            revoked_at IS NOT NULL
            OR expires_at <= pg_catalog.statement_timestamp()
          )
      `;
      await transaction`
        INSERT INTO murmur.access_tokens(
          token_id, tenant_id, key_id, secret_hash, token_role, name, expires_at
        ) VALUES (
          ${issued.token.tokenId}::uuid,
          ${tenantId.value}::uuid,
          ${issued.token.keyId},
          ${issued.hash},
          ${role},
          ${name},
          ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz
        )
      `;
    });
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  public async listTokens(
    tenantId: TenantId,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TokenSummary>> {
    this.ensureOpen();
    return await this.database.begin(
      async (transaction: TransactionSql): Promise<Page<TokenSummary>> => {
        await this.setTenantContext(transaction, tenantId);
        const rawRows: unknown = await transaction`
          SELECT
            token_id::text AS token_id,
            key_id,
            token_role,
            name,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            CASE WHEN expires_at IS NULL THEN NULL ELSE
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END AS expires_at,
            CASE WHEN revoked_at IS NULL THEN NULL ELSE
              to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END AS revoked_at,
            CASE WHEN last_used_at IS NULL THEN NULL ELSE
              to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END AS last_used_at
          FROM murmur.access_tokens
          WHERE tenant_id = ${tenantId.value}::uuid
            AND (
              ${cursor}::uuid IS NULL
              OR (created_at, token_id) < (
                SELECT cursor_token.created_at, cursor_token.token_id
                FROM murmur.access_tokens AS cursor_token
                WHERE cursor_token.tenant_id = ${tenantId.value}::uuid
                  AND cursor_token.token_id = ${cursor}::uuid
              )
            )
          ORDER BY created_at DESC, token_id DESC
          LIMIT ${limit + 1}
        `;
        const items: readonly TokenSummary[] = z.array(TokenRowSchema).parse(rawRows).map(mapToken);
        return page(items, limit, (item: TokenSummary): string => item.tokenId);
      },
    );
  }

  public async revokeToken(tenantId: TenantId, keyId: string): Promise<string | null> {
    this.ensureOpen();
    const tokenId: string | null = await this.database.begin(
      async (transaction: TransactionSql): Promise<string | null> => {
        await this.setTenantContext(transaction, tenantId);
        const rawRows: unknown = await transaction`
          UPDATE murmur.access_tokens
          SET revoked_at = pg_catalog.statement_timestamp()
          WHERE tenant_id = ${tenantId.value}::uuid
            AND key_id = ${keyId}
            AND revoked_at IS NULL
          RETURNING token_id::text AS token_id
        `;
        const row: TokenIdRow | undefined = z.array(TokenIdRowSchema).parse(rawRows)[0];
        return row === undefined ? null : row.token_id;
      },
    );
    await this.refreshCredentialAdmissions();
    return tokenId;
  }

  public async createTenant(
    principal: OperatorPrincipal,
    slug: string,
    displayName: string,
  ): Promise<{ readonly tenant: TenantSummary; readonly token: IssuedToken }> {
    this.ensureOpen();
    const tenantId: TenantId = TenantId.generate();
    const issued: ReturnType<typeof issueToken> = issueToken(
      tenantId,
      "tenant_admin",
      "Initial tenant administrator",
      null,
    );
    const rawRows: unknown = await this.database`
      SELECT
        tenant_id::text AS tenant_id,
        slug,
        display_name,
        status,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN suspended_at IS NULL THEN NULL ELSE
          to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS suspended_at
      FROM murmur.operator_create_tenant(
        ${principal.credentialHash},
        ${tenantId.value}::uuid,
        ${slug},
        ${displayName},
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${issued.token.name}
      )
    `;
    const tenant: TenantSummary = mapTenant(
      onlyRow(z.array(TenantRowSchema).parse(rawRows), "create tenant"),
    );
    await this.refreshCredentialAdmissions();
    return { tenant, token: issued.token };
  }

  public async listTenants(
    principal: OperatorPrincipal,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TenantSummary>> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT
        tenant_id::text AS tenant_id,
        slug,
        display_name,
        status,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        CASE WHEN suspended_at IS NULL THEN NULL ELSE
          to_char(suspended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS suspended_at
      FROM murmur.operator_list_tenants(
        ${principal.credentialHash},
        ${cursor}::uuid,
        ${limit + 1}
      )
    `;
    const items: readonly TenantSummary[] = z.array(TenantRowSchema).parse(rawRows).map(mapTenant);
    return page(items, limit, (item: TenantSummary): string => item.tenantId.value);
  }

  public async mintTenantAdminToken(
    principal: OperatorPrincipal,
    tenantId: TenantId,
    name: string,
    expiresAt: Instant | null,
  ): Promise<IssuedToken> {
    this.ensureOpen();
    const issued: ReturnType<typeof issueToken> = issueToken(
      tenantId,
      "tenant_admin",
      name,
      expiresAt,
    );
    await this.database`
      SELECT murmur.operator_mint_tenant_admin_token(
        ${principal.credentialHash},
        ${tenantId.value}::uuid,
        ${issued.token.tokenId}::uuid,
        ${issued.token.keyId},
        ${issued.hash},
        ${name},
        ${expiresAt === null ? null : expiresAt.toISOString()}::timestamptz
      )
    `;
    await this.refreshCredentialAdmissions();
    return issued.token;
  }

  private async changeTenantStatus(
    principal: OperatorPrincipal,
    functionName: "restore" | "suspend",
    tenantId: TenantId,
  ): Promise<boolean> {
    this.ensureOpen();
    const rawRows: unknown =
      functionName === "suspend"
        ? await this.database`
            SELECT murmur.operator_suspend_tenant(
              ${principal.credentialHash}, ${tenantId.value}::uuid
            ) AS changed
          `
        : await this.database`
            SELECT murmur.operator_restore_tenant(
              ${principal.credentialHash}, ${tenantId.value}::uuid
            ) AS changed
          `;
    const changed: boolean = onlyRow(
      z.array(BooleanRowSchema).parse(rawRows),
      `${functionName} tenant`,
    ).changed;
    await this.refreshCredentialAdmissions();
    return changed;
  }

  public async suspendTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean> {
    return await this.changeTenantStatus(principal, "suspend", tenantId);
  }

  public async restoreTenant(principal: OperatorPrincipal, tenantId: TenantId): Promise<boolean> {
    return await this.changeTenantStatus(principal, "restore", tenantId);
  }

  public async listAdminAudit(
    principal: OperatorPrincipal,
    limit: number,
  ): Promise<readonly AdminAuditEvent[]> {
    this.ensureOpen();
    const rawRows: unknown = await this.database`
      SELECT
        audit_id,
        actor_token_id::text AS actor_token_id,
        actor_key_id,
        action,
        target_kind,
        target_id,
        metadata,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM murmur.operator_list_admin_audit(${principal.credentialHash}, ${limit})
    `;
    return z
      .array(AuditRowSchema)
      .parse(rawRows)
      .map(
        (row: AuditRow): AdminAuditEvent => ({
          action: row.action,
          actorKeyId: row.actor_key_id,
          actorTokenId: row.actor_token_id,
          auditId: row.audit_id,
          createdAt: Instant.parse(row.created_at),
          metadata: row.metadata,
          targetId: row.target_id,
          targetKind: row.target_kind,
        }),
      );
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.credentialRefreshTimer !== null) clearInterval(this.credentialRefreshTimer);
    this.credentialRefreshTimer = null;
    await this.credentialRefreshQueue;
    await this.database.end({ timeout: 5 });
  }
}
