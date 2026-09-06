import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { z } from "zod";

import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type IssuedTokenDto,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListTokensOutput,
  ListTokensOutputSchema,
  RevokeTokenOutputSchema,
  TenantStatusOutputSchema,
  type TokenSummaryDto,
  toIssuedTokenDto,
} from "../../src/hosted/contracts.js";
import { issueSelfServiceToken, selfServiceTenantId } from "../../src/hosted/token-issuance.js";
import {
  type ProductionStreamCleanupScope,
  productionStreamCleanup,
} from "./production-stream-cleanup.js";
import { ProductionStreamClient, productionStreamHeaders } from "./production-stream-client.js";
import {
  type ProductionStreamCleanup,
  type ProductionStreamConfig,
  ProductionStreamFailure,
  type ProductionStreamRuntime,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamDeadline, streamJsonRequest } from "./production-stream-io.js";

export type ProductionStreamControl = {
  readonly connect: (signal?: AbortSignal) => Promise<void>;
  readonly close: (signal?: AbortSignal) => Promise<void>;
  readonly call: <T>(
    name: string,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
  readonly approved: <T>(
    name: "create_access_token" | "revoke_access_token" | "suspend_tenant",
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) => Promise<T>;
};

export class ProductionStreamFixture {
  private readonly registrationSecret: string = randomBytes(32).toString("base64url");
  private readonly tenantId: string = selfServiceTenantId(this.registrationSecret).value;
  private readonly administrator: IssuedTokenDto = toIssuedTokenDto(
    issueSelfServiceToken(selfServiceTenantId(this.registrationSecret), this.registrationSecret)
      .token,
  );
  private readonly unique: string = randomUUID();
  private readonly workerName: string = `Production stream ${this.unique}`;
  private readonly personalId: string = this.administrator.personal_id;
  private readonly connections: ProductionStreamControl[] = [];
  private worker: IssuedTokenDto | null = null;
  private created: boolean = false;
  private signupAttempted: boolean = false;
  private mintAttempted: boolean = false;
  public readonly cleanup: () => Promise<ProductionStreamCleanup>;

  public constructor(
    private readonly config: ProductionStreamConfig,
    private readonly runtime: ProductionStreamRuntime,
    private readonly connection: (token: string) => ProductionStreamControl = (
      token: string,
    ): ProductionStreamControl => new ProductionStreamClient(config.endpoint, token, runtime),
  ) {
    this.cleanup = productionStreamCleanup({
      revokeWorker: async (scope: ProductionStreamCleanupScope): Promise<boolean> =>
        await this.revokeWorker(scope.signal),
      verifyWorker: async (scope: ProductionStreamCleanupScope): Promise<boolean> =>
        this.worker !== null && (await this.unauthorized(this.worker.secret, scope.signal)),
      revokeAdministrator: async (scope: ProductionStreamCleanupScope): Promise<boolean> => {
        if (!this.signupAttempted) return false;
        const admin: ProductionStreamControl = await this.open(
          this.administrator.secret,
          scope.signal,
        );
        const result: { readonly revoked: boolean } = await admin.approved(
          "revoke_access_token",
          { key_id: this.administrator.key_id },
          RevokeTokenOutputSchema,
          scope.signal,
        );
        return result.revoked;
      },
      verifyAdministrator: async (scope: ProductionStreamCleanupScope): Promise<boolean> =>
        this.signupAttempted && (await this.unauthorized(this.administrator.secret, scope.signal)),
      suspendTenant: async (scope: ProductionStreamCleanupScope): Promise<boolean> => {
        if (!this.signupAttempted) return false;
        const operator: ProductionStreamControl = await this.open(
          this.config.operatorToken,
          scope.signal,
        );
        const result: { readonly changed: boolean } = await operator.approved(
          "suspend_tenant",
          { tenant_id: this.tenantId },
          TenantStatusOutputSchema,
          scope.signal,
        );
        return this.created || result.changed;
      },
      closeConnections: async (scope: ProductionStreamCleanupScope): Promise<boolean> => {
        const results: PromiseSettledResult<void>[] = await Promise.allSettled(
          this.connections.map(
            async (item: ProductionStreamControl): Promise<void> =>
              await streamDeadline(
                async (signal: AbortSignal): Promise<void> => await item.close(signal),
                25_000,
                scope.signal,
              ),
          ),
        );
        return results.every(
          (result: PromiseSettledResult<void>): boolean => result.status === "fulfilled",
        );
      },
    });
  }

  private async open(token: string, signal: AbortSignal): Promise<ProductionStreamControl> {
    signal.throwIfAborted();
    requireProductionStream(this.connections.length < 4);
    const connection: ProductionStreamControl = this.connection(token);
    this.connections.push(connection);
    await connection.connect(signal);
    return connection;
  }

  public async provision(signal: AbortSignal): Promise<string> {
    const slug: string = `stream-${this.unique}`;
    const displayName: string = `Production stream ${this.unique}`;
    const input: Record<string, unknown> = {
      slug,
      display_name: displayName,
      registration_secret: this.registrationSecret,
    };
    this.signupAttempted = true;
    let created: CreateTenantOutput | null = null;
    for (let attempt: number = 0; attempt < 3; attempt += 1) {
      signal.throwIfAborted();
      try {
        const response: { readonly status: number; readonly value: unknown } =
          await streamJsonRequest(
            this.runtime.fetch,
            new URL("/v1/tenants", this.config.endpoint),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            },
            signal,
          );
        requireProductionStream(response.status === 201);
        created = CreateTenantOutputSchema.parse(response.value);
        break;
      } catch (_error: unknown) {
        if (attempt === 2) throw new ProductionStreamFailure();
      }
    }
    requireProductionStream(
      created !== null &&
        created.tenant.tenant_id === this.tenantId &&
        created.tenant.slug === slug &&
        created.tenant.display_name === displayName &&
        created.tenant.status === "active" &&
        isDeepStrictEqual(created.token, this.administrator),
    );
    this.created = true;
    const admin: ProductionStreamControl = await this.open(this.administrator.secret, signal);
    this.mintAttempted = true;
    const expiresAt: string = new Date(
      Date.parse(this.runtime.clock.timestamp()) + 2 * 60 * 60_000,
    ).toISOString();
    const issued: IssuedTokenOutput = await admin.approved(
      "create_access_token",
      {
        name: this.workerName,
        role: "agent",
        repository: "canary/production-stream",
        personal_id: this.personalId,
        expires_at: expiresAt,
      },
      IssuedTokenOutputSchema,
      signal,
    );
    requireProductionStream(
      issued.token.tenant_id === this.tenantId &&
        issued.token.role === "agent" &&
        issued.token.name === this.workerName &&
        issued.token.personal_id === this.personalId &&
        issued.token.repository === "canary/production-stream" &&
        issued.token.expires_at === expiresAt &&
        issued.token.agent_id === null,
    );
    this.worker = issued.token;
    await admin.close(signal);
    return issued.token.secret;
  }

  private async revokeWorker(signal: AbortSignal): Promise<boolean> {
    if (!this.mintAttempted) return false;
    const admin: ProductionStreamControl = await this.open(this.administrator.secret, signal);
    let keyId: string;
    if (this.worker !== null) keyId = this.worker.key_id;
    else {
      // A lost mint response cannot authorize a second mint or a cross-tenant directory scan.
      const listed: ListTokensOutput = await admin.call(
        "list_access_tokens",
        { limit: 100 },
        ListTokensOutputSchema,
        signal,
      );
      requireProductionStream(listed.next_cursor === null && listed.tokens.length <= 100);
      const matches: TokenSummaryDto[] = listed.tokens.filter(
        (token: TokenSummaryDto): boolean =>
          token.role === "agent" &&
          token.name === this.workerName &&
          token.personal_id === this.personalId &&
          token.repository === "canary/production-stream",
      );
      requireProductionStream(matches.length === 1);
      const token: TokenSummaryDto | undefined = matches[0];
      requireProductionStream(token !== undefined);
      keyId = token.key_id;
    }
    const result: { readonly revoked: boolean } = await admin.approved(
      "revoke_access_token",
      { key_id: keyId },
      RevokeTokenOutputSchema,
      signal,
    );
    if (result.revoked) return true;
    const listed: ListTokensOutput = await admin.call(
      "list_access_tokens",
      { limit: 100 },
      ListTokensOutputSchema,
      signal,
    );
    requireProductionStream(listed.next_cursor === null && listed.tokens.length <= 100);
    return listed.tokens.some(
      (token: TokenSummaryDto): boolean => token.key_id === keyId && token.revoked_at !== null,
    );
  }

  private async unauthorized(token: string, outerSignal: AbortSignal): Promise<boolean> {
    return await streamDeadline(
      async (signal: AbortSignal): Promise<boolean> => {
        const headers: Headers = productionStreamHeaders(token);
        headers.set("Accept", "text/event-stream");
        // This probe cannot create an SDK session if revocation unexpectedly failed.
        const response: Response = await this.runtime.fetch(this.config.endpoint, {
          method: "GET",
          headers,
          redirect: "error",
          signal,
        });
        if (response.body !== null) await response.body.cancel();
        return (
          response.status === 401 &&
          response.headers.get("mcp-session-id") === null &&
          (response.headers.get("www-authenticate") ?? "").startsWith("Bearer ")
        );
      },
      20_000,
      outerSignal,
    );
  }
}
