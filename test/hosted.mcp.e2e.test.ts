import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

import { expect, test } from "bun:test";
import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

import {
  BroadcastMessageOutputSchema,
  InboxOutputSchema,
  ListAgentsOutputSchema,
  MarkMessagesReadOutputSchema,
  RegisterAgentOutputSchema,
  SendMessageOutputSchema,
  type BroadcastMessageOutput,
  type InboxOutput,
  type ListAgentsOutput,
  type MarkMessagesReadOutput,
  type RegisterAgentOutput,
  type SendMessageOutput,
} from "../src/domain/contracts.js";
import {
  CreateTenantOutputSchema,
  IssuedOperatorTokenOutputSchema,
  IssuedTokenOutputSchema,
  ListAdminAuditOutputSchema,
  ListOperatorTokensOutputSchema,
  ListTenantsOutputSchema,
  ListTokensOutputSchema,
  RevokeTokenOutputSchema,
  TenantStatusOutputSchema,
  type CreateTenantOutput,
  type IssuedOperatorTokenOutput,
  type IssuedTokenOutput,
  type ListAdminAuditOutput,
  type ListOperatorTokensOutput,
  type ListTenantsOutput,
  type ListTokensOutput,
  type RevokeTokenOutput,
  type TenantStatusOutput,
} from "../src/hosted/contracts.js";
import {
  deriveBootstrapCredential,
  type BootstrapCredential,
} from "../src/hosted/bootstrap-secret.js";
import { startHttpServer, type MurmurHttpServer } from "../src/http-server.js";
import { postgresSslOptions, type PostgresTlsConfiguration } from "../src/postgres-tls.js";

const databaseUrl: string | undefined = process.env["MURMUR_TEST_APP_DATABASE_URL"];
const adminDatabaseUrl: string | undefined = process.env["MURMUR_TEST_ADMIN_DATABASE_URL"];
const bootstrapLegacyToken: string | undefined = process.env["MURMUR_TEST_BOOTSTRAP_LEGACY_TOKEN"];
const existingOperatorToken: string | undefined = process.env["MURMUR_TEST_OPERATOR_TOKEN"];
const testTlsConfiguration: PostgresTlsConfiguration =
  process.env["MURMUR_TEST_DATABASE_TLS_INSECURE"] === "1"
    ? { mode: "insecure" }
    : { mode: "verify-system" };
const JsonRpcEnvelopeSchema: z.ZodObject<{
  result: z.ZodType<unknown>;
}> = z.object({ result: z.unknown() });
const ToolNamesEnvelopeSchema: z.ZodObject<{
  result: z.ZodObject<{
    tools: z.ZodArray<z.ZodObject<{ name: z.ZodString }>>;
  }>;
}> = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});
const ResourceUpdatedEnvelopeSchema: z.ZodType<{
  readonly method: "notifications/resources/updated";
  readonly params: { readonly uri: string };
}> = z.object({
  method: z.literal("notifications/resources/updated"),
  params: z.object({ uri: z.string() }),
});

function headers(token: string, sessionId: string | null = null): Headers {
  const value: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "feature/hosted-isolation",
    "X-Murmur-Client": "codex",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    value.set("Mcp-Session-Id", sessionId);
    value.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return value;
}

function operatorSecret(): string {
  return `mur_op_${randomBytes(6).toString("base64url")}_${randomBytes(32).toString("base64url")}`;
}

async function payload(response: Response): Promise<unknown> {
  const body: string = await response.text();
  const contentType: string = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  const data: string | undefined = body
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "))
    .at(-1);
  if (data === undefined) throw new Error("Hosted MCP response did not include a data event");
  return JSON.parse(data.slice("data: ".length));
}

async function post(
  url: URL,
  token: string,
  sessionId: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: headers(token, sessionId),
    method: "POST",
  });
}

async function initialize(url: URL, token: string, clientName: string): Promise<string> {
  const response: Response = await post(url, token, null, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await payload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Hosted MCP initialize omitted its session ID");
  const initialized: Response = await post(url, token, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  expect(initialized.status).toBe(202);
  return sessionId;
}

async function toolNames(url: URL, token: string, sessionId: string): Promise<readonly string[]> {
  const response: Response = await post(url, token, sessionId, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
  });
  expect(response.status).toBe(200);
  return ToolNamesEnvelopeSchema.parse(await payload(response)).result.tools.map(
    (tool: { readonly name: string }): string => tool.name,
  );
}

async function callTool<T>(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  name: string,
  argumentsValue: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  expect(response.status).toBe(200);
  const envelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
    await payload(response),
  );
  const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
  if (result.isError === true) {
    throw new Error(`Hosted MCP tool '${name}' failed: ${JSON.stringify(result.content)}`);
  }
  return schema.parse(result.structuredContent);
}

async function callToolExpectingError(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<string> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: argumentsValue, name },
  });
  expect(response.status).toBe(200);
  const envelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
    await payload(response),
  );
  const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
  expect(result.isError).toBe(true);
  return JSON.stringify(result.content);
}

async function subscribeInbox(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  uri: string,
): Promise<void> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "resources/subscribe",
    params: { uri },
  });
  expect(response.status).toBe(200);
  JsonRpcEnvelopeSchema.parse(await payload(response));
}

async function subscribeInboxExpectingError(
  url: URL,
  token: string,
  sessionId: string,
  requestId: number,
  uri: string,
): Promise<string> {
  const response: Response = await post(url, token, sessionId, {
    id: requestId,
    jsonrpc: "2.0",
    method: "resources/subscribe",
    params: { uri },
  });
  expect(response.status).toBe(200);
  return JSON.stringify(await payload(response));
}

async function nextResourceUpdate(response: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) throw new Error("Hosted subscription response omitted its body");
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder: TextDecoder = new TextDecoder();
  let buffered: string = "";
  while (true) {
    const result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
      await reader.read();
    if (result.done) throw new Error("Hosted subscription closed before an update");
    buffered += decoder.decode(result.value, { stream: true });
    const lines: string[] = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const parsed: z.ZodSafeParseResult<z.infer<typeof ResourceUpdatedEnvelopeSchema>> =
        ResourceUpdatedEnvelopeSchema.safeParse(JSON.parse(line.slice("data: ".length)));
      if (parsed.success) return parsed.data.params.uri;
    }
  }
}

async function configureBootstrap(
  configuredAdminDatabaseUrl: string,
  credential: BootstrapCredential,
): Promise<void> {
  const database: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    await database`
      SELECT murmur.configure_operator_bootstrap(
        ${randomUUID()}::uuid,
        ${credential.keyId},
        ${credential.hash}
      )
    `;
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function finalizeTenantContract(configuredAdminDatabaseUrl: string): Promise<boolean> {
  const database: Sql = postgres(configuredAdminDatabaseUrl, {
    max: 1,
    ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
  });
  try {
    const rows: { readonly changed: boolean }[] = await database`
      SELECT murmur.finalize_tenant_contract() AS changed
    `;
    const row: { readonly changed: boolean } | undefined = rows[0];
    if (row === undefined) throw new Error("Tenant contract finalization returned no row");
    return row.changed;
  } finally {
    await database.end({ timeout: 5 });
  }
}

test.skipIf(
  databaseUrl === undefined ||
    (bootstrapLegacyToken === undefined && existingOperatorToken === undefined) ||
    (bootstrapLegacyToken !== undefined && adminDatabaseUrl === undefined),
)(
  "hosted MCP isolates tenants and manages credential lifecycles",
  async (): Promise<void> => {
    const configuredDatabaseUrl: string | undefined = databaseUrl;
    if (configuredDatabaseUrl === undefined) {
      throw new Error("MURMUR_TEST_APP_DATABASE_URL is required");
    }
    const configuredAdminDatabaseUrl: string | undefined = adminDatabaseUrl;
    const bootstrapCredential: BootstrapCredential | null =
      bootstrapLegacyToken === undefined
        ? null
        : deriveBootstrapCredential(configuredAdminDatabaseUrl ?? "");
    if (bootstrapCredential !== null && configuredAdminDatabaseUrl !== undefined) {
      await configureBootstrap(configuredAdminDatabaseUrl, bootstrapCredential);
    }
    if (configuredAdminDatabaseUrl !== undefined && bootstrapLegacyToken === undefined) {
      await finalizeTenantContract(configuredAdminDatabaseUrl);
      expect(await finalizeTenantContract(configuredAdminDatabaseUrl)).toBe(false);
    }
    const unique: string = randomUUID().replaceAll("-", "").slice(0, 12);
    const serverEnvironment: NodeJS.ProcessEnv = {
      MURMUR_AUTH_MODE: bootstrapLegacyToken === undefined ? "multi-tenant" : "hybrid",
      MURMUR_DATABASE_URL: configuredDatabaseUrl,
      MURMUR_HTTP_HOST: "127.0.0.1",
      ...(bootstrapLegacyToken === undefined ? {} : { MURMUR_TENANT_CONTRACT_VERSION: "1" }),
      ...(testTlsConfiguration.mode === "insecure" ? { MURMUR_DATABASE_TLS_INSECURE: "1" } : {}),
      PORT: "0",
      ...(bootstrapLegacyToken === undefined
        ? {}
        : {
            MURMUR_ALLOW_BOOTSTRAP: "1",
            MURMUR_API_TOKEN: bootstrapLegacyToken,
          }),
    };
    let server: MurmurHttpServer = await startHttpServer(serverEnvironment);
    try {
      const invalid: Response = await post(server.mcpUrl, `invalid-${unique}`, null, {});
      expect(invalid.status).toBe(401);

      let operatorToken: string;
      let initialOperatorKeyId: string;
      if (bootstrapLegacyToken === undefined) {
        if (existingOperatorToken === undefined) throw new Error("Operator token is required");
        operatorToken = existingOperatorToken;
        initialOperatorKeyId = "";
      } else {
        if (bootstrapCredential === null) throw new Error("Bootstrap credential is required");
        const bootstrapSession: string = await initialize(
          server.mcpUrl,
          bootstrapCredential.secret,
          "hosted-bootstrap-test",
        );
        const bootstrapTools: readonly string[] = await toolNames(
          server.mcpUrl,
          bootstrapCredential.secret,
          bootstrapSession,
        );
        expect(bootstrapTools).toContain("bootstrap_operator");
        expect(bootstrapTools).not.toContain("register_agent");
        expect(bootstrapTools).not.toContain("create_tenant");
        const bootstrapped: IssuedOperatorTokenOutput = await callTool(
          server.mcpUrl,
          bootstrapCredential.secret,
          bootstrapSession,
          3,
          "bootstrap_operator",
          { name: "Initial hosted operator", secret: operatorSecret() },
          IssuedOperatorTokenOutputSchema,
        );
        expect(bootstrapped.token.secret).toStartWith("mur_op_");
        const replay: Response = await post(
          server.mcpUrl,
          bootstrapCredential.secret,
          bootstrapSession,
          { id: 4, jsonrpc: "2.0", method: "tools/list", params: {} },
        );
        expect(replay.status).toBe(401);
        if (configuredAdminDatabaseUrl !== undefined) {
          await configureBootstrap(
            configuredAdminDatabaseUrl,
            deriveBootstrapCredential(`${configuredAdminDatabaseUrl}#completed-bootstrap-retry`),
          );
        }
        operatorToken = bootstrapped.token.secret;
        initialOperatorKeyId = bootstrapped.token.key_id;
      }
      let operatorSession: string = await initialize(
        server.mcpUrl,
        operatorToken,
        "hosted-operator-test",
      );
      let operatorTools: readonly string[] = await toolNames(
        server.mcpUrl,
        operatorToken,
        operatorSession,
      );
      if (bootstrapLegacyToken === undefined) expect(operatorTools).toContain("create_tenant");
      else expect(operatorTools).not.toContain("create_tenant");
      expect(operatorTools).toContain("create_operator_token");
      expect(operatorTools).not.toContain("register_agent");

      if (bootstrapLegacyToken !== undefined) {
        expect(operatorTools).toContain("adopt_legacy_founding_token");
        const adopted: TenantStatusOutput = await callTool(
          server.mcpUrl,
          operatorToken,
          operatorSession,
          41,
          "adopt_legacy_founding_token",
          {},
          TenantStatusOutputSchema,
        );
        expect(adopted.changed).toBe(true);
        const adoptedAgain: TenantStatusOutput = await callTool(
          server.mcpUrl,
          operatorToken,
          operatorSession,
          42,
          "adopt_legacy_founding_token",
          {},
          TenantStatusOutputSchema,
        );
        expect(adoptedAgain.changed).toBe(false);

        const v1FoundingSession: string = await initialize(
          server.mcpUrl,
          bootstrapLegacyToken,
          "contract-v1-founding-test",
        );
        const v1FoundingTools: readonly string[] = await toolNames(
          server.mcpUrl,
          bootstrapLegacyToken,
          v1FoundingSession,
        );
        expect(v1FoundingTools).toContain("register_agent");
        expect(v1FoundingTools).not.toContain("create_tenant");
        if (configuredAdminDatabaseUrl === undefined) {
          throw new Error("Contract finalization requires the admin database URL");
        }
        expect(await finalizeTenantContract(configuredAdminDatabaseUrl)).toBe(true);
        expect(await finalizeTenantContract(configuredAdminDatabaseUrl)).toBe(false);
        await server.stop();
        server = await startHttpServer({
          MURMUR_AUTH_MODE: "multi-tenant",
          MURMUR_DATABASE_URL: configuredDatabaseUrl,
          MURMUR_TENANT_CONTRACT_VERSION: "2",
          MURMUR_HTTP_HOST: "127.0.0.1",
          ...(testTlsConfiguration.mode === "insecure"
            ? { MURMUR_DATABASE_TLS_INSECURE: "1" }
            : {}),
          PORT: "0",
        });
        operatorSession = await initialize(
          server.mcpUrl,
          operatorToken,
          "contract-v2-operator-test",
        );
        operatorTools = await toolNames(server.mcpUrl, operatorToken, operatorSession);
        expect(operatorTools).toContain("create_tenant");
      }

      if (bootstrapLegacyToken !== undefined) {
        const completedBootstrapServer: MurmurHttpServer = await startHttpServer({
          MURMUR_ALLOW_BOOTSTRAP: "1",
          MURMUR_API_TOKEN: bootstrapLegacyToken,
          MURMUR_AUTH_MODE: "hybrid",
          MURMUR_DATABASE_URL: configuredDatabaseUrl,
          MURMUR_HTTP_HOST: "127.0.0.1",
          ...(testTlsConfiguration.mode === "insecure"
            ? { MURMUR_DATABASE_TLS_INSECURE: "1" }
            : {}),
          PORT: "0",
        });
        try {
          const completedSession: string = await initialize(
            completedBootstrapServer.mcpUrl,
            operatorToken,
            "completed-bootstrap-test",
          );
          expect(
            await toolNames(completedBootstrapServer.mcpUrl, operatorToken, completedSession),
          ).not.toContain("bootstrap_operator");
        } finally {
          await completedBootstrapServer.stop();
        }
        const strictServer: MurmurHttpServer = await startHttpServer({
          MURMUR_AUTH_MODE: "multi-tenant",
          MURMUR_DATABASE_URL: configuredDatabaseUrl,
          MURMUR_TENANT_CONTRACT_VERSION: "2",
          MURMUR_HTTP_HOST: "127.0.0.1",
          ...(testTlsConfiguration.mode === "insecure"
            ? { MURMUR_DATABASE_TLS_INSECURE: "1" }
            : {}),
          PORT: "0",
        });
        try {
          const strictSession: string = await initialize(
            strictServer.mcpUrl,
            operatorToken,
            "strict-operator-test",
          );
          expect(await toolNames(strictServer.mcpUrl, operatorToken, strictSession)).toContain(
            "create_tenant",
          );
          const foundingSession: string = await initialize(
            strictServer.mcpUrl,
            bootstrapLegacyToken,
            "strict-founding-test",
          );
          expect(
            await toolNames(strictServer.mcpUrl, bootstrapLegacyToken, foundingSession),
          ).toContain("create_access_token");
        } finally {
          await strictServer.stop();
        }
      }

      const backupOperator: IssuedOperatorTokenOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        5,
        "create_operator_token",
        { name: "Rotation test operator" },
        IssuedOperatorTokenOutputSchema,
      );
      const backupOperatorSession: string = await initialize(
        server.mcpUrl,
        backupOperator.token.secret,
        "backup-operator-test",
      );
      const listedOperators: ListOperatorTokensOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        6,
        "list_operator_tokens",
        { limit: 1 },
        ListOperatorTokensOutputSchema,
      );
      expect(
        listedOperators.tokens.map(
          (token: ListOperatorTokensOutput["tokens"][number]): string => token.key_id,
        ),
      ).toContain(backupOperator.token.key_id);
      expect(listedOperators.next_cursor).not.toBeNull();
      const operatorCursor: string | null = listedOperators.next_cursor;
      if (operatorCursor === null) throw new Error("Operator list page did not return a cursor");
      const nextOperators: ListOperatorTokensOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        61,
        "list_operator_tokens",
        { cursor: operatorCursor, limit: 1 },
        ListOperatorTokensOutputSchema,
      );
      expect(nextOperators.tokens).toHaveLength(1);
      const backupRevoked: RevokeTokenOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        7,
        "revoke_operator_token",
        { key_id: backupOperator.token.key_id },
        RevokeTokenOutputSchema,
      );
      expect(backupRevoked.revoked).toBe(true);
      const revokedOperatorRequest: Response = await post(
        server.mcpUrl,
        backupOperator.token.secret,
        backupOperatorSession,
        { id: 70, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      expect(revokedOperatorRequest.status).toBe(401);
      if (initialOperatorKeyId !== "") {
        const lastOperatorError: string = await callToolExpectingError(
          server.mcpUrl,
          operatorToken,
          operatorSession,
          8,
          "revoke_operator_token",
          { key_id: initialOperatorKeyId },
        );
        expect(lastOperatorError).toContain("last active operator");
      }

      const operatorDataError: string = await callToolExpectingError(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        71,
        "register_agent",
        { agent_id: `operator-forbidden-${unique}`, display_name: "Forbidden" },
      );
      expect(operatorDataError).toContain("cannot access tenant data");
      const operatorBootstrapError: string = await callToolExpectingError(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        711,
        "bootstrap_operator",
        { name: "Forbidden bootstrap" },
      );
      expect(operatorBootstrapError).toContain("Unknown tool");

      const tenantA: CreateTenantOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        3,
        "create_tenant",
        { display_name: `Tenant A ${unique}`, slug: `tenant-a-${unique}` },
        CreateTenantOutputSchema,
      );
      const tenantB: CreateTenantOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        4,
        "create_tenant",
        { display_name: `Tenant B ${unique}`, slug: `tenant-b-${unique}` },
        CreateTenantOutputSchema,
      );
      const listedTenants: ListTenantsOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        401,
        "list_tenants",
        { limit: 2 },
        ListTenantsOutputSchema,
      );
      expect(listedTenants.tenants).toHaveLength(2);
      expect(listedTenants.next_cursor).not.toBeNull();
      const mintedAdministrator: IssuedTokenOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        402,
        "mint_tenant_admin_token",
        { name: "Operator-minted tenant A administrator", tenant_id: tenantA.tenant.tenant_id },
        IssuedTokenOutputSchema,
      );
      const mintedAdministratorSession: string = await initialize(
        server.mcpUrl,
        mintedAdministrator.token.secret,
        "operator-minted-admin-test",
      );
      expect(
        await toolNames(
          server.mcpUrl,
          mintedAdministrator.token.secret,
          mintedAdministratorSession,
        ),
      ).toContain("create_access_token");

      const adminASession: string = await initialize(
        server.mcpUrl,
        tenantA.token.secret,
        "tenant-a-admin-test",
      );
      const adminBSession: string = await initialize(
        server.mcpUrl,
        tenantB.token.secret,
        "tenant-b-admin-test",
      );
      const adminTools: readonly string[] = await toolNames(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
      );
      expect(adminTools).toContain("register_agent");
      expect(adminTools).toContain("create_access_token");
      expect(adminTools).not.toContain("create_tenant");

      const agentAToken: IssuedTokenOutput = await callTool(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
        5,
        "create_access_token",
        { name: "Tenant A agent", role: "agent" },
        IssuedTokenOutputSchema,
      );
      const agentBToken: IssuedTokenOutput = await callTool(
        server.mcpUrl,
        tenantB.token.secret,
        adminBSession,
        6,
        "create_access_token",
        { name: "Tenant B agent", role: "agent" },
        IssuedTokenOutputSchema,
      );
      const listedAccessTokens: ListTokensOutput = await callTool(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
        403,
        "list_access_tokens",
        { limit: 2 },
        ListTokensOutputSchema,
      );
      expect(listedAccessTokens.tokens).toHaveLength(2);
      expect(listedAccessTokens.next_cursor).not.toBeNull();
      const expiration: string = new Date(Date.now() + 3_000).toISOString();
      const expiringOperator: IssuedOperatorTokenOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        404,
        "create_operator_token",
        { expires_at: expiration, name: "Expiring operator" },
        IssuedOperatorTokenOutputSchema,
      );
      const expiringTenantToken: IssuedTokenOutput = await callTool(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
        405,
        "create_access_token",
        { expires_at: expiration, name: "Expiring tenant agent", role: "agent" },
        IssuedTokenOutputSchema,
      );
      const expiringOperatorSession: string = await initialize(
        server.mcpUrl,
        expiringOperator.token.secret,
        "expiring-operator-test",
      );
      const expiringTenantSession: string = await initialize(
        server.mcpUrl,
        expiringTenantToken.token.secret,
        "expiring-tenant-test",
      );
      await Bun.sleep(3_200);
      const expiredOperatorRequest: Response = await post(
        server.mcpUrl,
        expiringOperator.token.secret,
        expiringOperatorSession,
        { id: 406, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      const expiredTenantRequest: Response = await post(
        server.mcpUrl,
        expiringTenantToken.token.secret,
        expiringTenantSession,
        { id: 407, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      expect(expiredOperatorRequest.status).toBe(401);
      expect(expiredTenantRequest.status).toBe(401);
      const agentASession: string = await initialize(
        server.mcpUrl,
        agentAToken.token.secret,
        "tenant-a-agent-test",
      );
      const agentBSession: string = await initialize(
        server.mcpUrl,
        agentBToken.token.secret,
        "tenant-b-agent-test",
      );
      expect(await toolNames(server.mcpUrl, agentAToken.token.secret, agentASession)).not.toContain(
        "create_access_token",
      );
      const crossSession: Response = await post(
        server.mcpUrl,
        tenantB.token.secret,
        adminASession,
        {
          id: 9,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        },
      );
      expect(crossSession.status).toBe(404);
      expect(
        await callToolExpectingError(
          server.mcpUrl,
          tenantA.token.secret,
          adminASession,
          91,
          "create_operator_token",
          { name: "Forbidden operator" },
        ),
      ).toContain("Unknown tool");
      expect(
        await callToolExpectingError(
          server.mcpUrl,
          agentAToken.token.secret,
          agentASession,
          92,
          "create_access_token",
          { name: "Forbidden administrator", role: "agent" },
        ),
      ).toContain("Unknown tool");

      const sharedSender: string = `hosted-shared-sender-${unique}`;
      const senderA: string = sharedSender;
      const receiverA: string = `hosted-a-receiver-${unique}`;
      const senderB: string = sharedSender;
      const receiverB: string = `hosted-b-receiver-${unique}`;
      const registrations: readonly [string, string, string][] = [
        [agentAToken.token.secret, agentASession, senderA],
        [agentAToken.token.secret, agentASession, receiverA],
        [agentBToken.token.secret, agentBSession, senderB],
        [agentBToken.token.secret, agentBSession, receiverB],
      ];
      let registrationId: number = 10;
      for (const [token, session, agentId] of registrations) {
        const registration: RegisterAgentOutput = await callTool(
          server.mcpUrl,
          token,
          session,
          registrationId,
          "register_agent",
          { agent_id: agentId, display_name: agentId },
          RegisterAgentOutputSchema,
        );
        expect(registration.agent.agent_id).toBe(agentId);
        registrationId += 1;
      }

      if (configuredAdminDatabaseUrl !== undefined) {
        const quotaDatabase: Sql = postgres(configuredAdminDatabaseUrl, {
          max: 1,
          ssl: postgresSslOptions(configuredAdminDatabaseUrl, testTlsConfiguration),
        });
        try {
          await quotaDatabase`
          DELETE FROM murmur.access_tokens
          WHERE tenant_id = ${tenantA.tenant.tenant_id}::uuid
            AND (
              revoked_at IS NOT NULL
              OR expires_at <= pg_catalog.statement_timestamp()
            )
        `;
          await quotaDatabase`
          UPDATE murmur.tenant_resource_usage
          SET
            access_token_count = 1000,
            agent_count = 1000,
            broadcast_content_bytes = 67108864,
            broadcast_count = 10000,
            message_count = 100000
          WHERE tenant_id = ${tenantA.tenant.tenant_id}::uuid
        `;
          expect(
            await callToolExpectingError(
              server.mcpUrl,
              agentAToken.token.secret,
              agentASession,
              410,
              "register_agent",
              { agent_id: `quota-agent-${unique}`, display_name: "Quota rejected" },
            ),
          ).toContain("tenant agent quota exceeded");
          expect(
            await callToolExpectingError(
              server.mcpUrl,
              agentAToken.token.secret,
              agentASession,
              411,
              "send_message",
              {
                content: "quota rejected",
                recipient_id: receiverA,
                sender_id: senderA,
              },
            ),
          ).toContain("tenant retained-message quota exceeded");
          expect(
            await callToolExpectingError(
              server.mcpUrl,
              tenantA.token.secret,
              adminASession,
              412,
              "create_access_token",
              { name: "Quota rejected token", role: "agent" },
            ),
          ).toContain("tenant access-token quota exceeded");
          expect(
            await callToolExpectingError(
              server.mcpUrl,
              tenantA.token.secret,
              adminASession,
              413,
              "broadcast_message",
              {
                audience: { repository: "quota/no-recipients" },
                content: "quota rejected broadcast",
                sender_id: senderA,
              },
            ),
          ).toContain("tenant retained-broadcast quota exceeded");
        } finally {
          await quotaDatabase`
          UPDATE murmur.tenant_resource_usage AS usage
          SET
            agent_count = (
              SELECT count(*) FROM murmur.agents AS agent
              WHERE agent.tenant_id = usage.tenant_id
            ),
            access_token_count = (
              SELECT count(*) FROM murmur.access_tokens AS access_token
              WHERE access_token.tenant_id = usage.tenant_id
            ),
            broadcast_count = (
              SELECT count(*) FROM murmur.broadcasts AS broadcast
              WHERE broadcast.tenant_id = usage.tenant_id
            ),
            broadcast_content_bytes = (
              SELECT coalesce(sum(octet_length(broadcast.content)), 0)::bigint
              FROM murmur.broadcasts AS broadcast
              WHERE broadcast.tenant_id = usage.tenant_id
            ),
            message_count = (
              SELECT count(*) FROM murmur.messages AS message
              WHERE message.tenant_id = usage.tenant_id
            ),
            message_content_bytes = (
              SELECT coalesce(sum(octet_length(message.content)), 0)::bigint
              FROM murmur.messages AS message
              WHERE message.tenant_id = usage.tenant_id
            )
          WHERE usage.tenant_id = ${tenantA.tenant.tenant_id}::uuid
        `;
          await quotaDatabase.end({ timeout: 5 });
        }
      }

      const receiverAUri: string = `murmur://inbox/${receiverA}`;
      const receiverBUri: string = `murmur://inbox/${receiverB}`;
      await subscribeInbox(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        408,
        receiverAUri,
      );
      await subscribeInbox(
        server.mcpUrl,
        agentBToken.token.secret,
        agentBSession,
        409,
        receiverBUri,
      );
      const streamAAbortController: AbortController = new AbortController();
      const streamBAbortController: AbortController = new AbortController();
      const streamA: Response = await fetch(server.mcpUrl, {
        headers: headers(agentAToken.token.secret, agentASession),
        signal: streamAAbortController.signal,
      });
      const streamB: Response = await fetch(server.mcpUrl, {
        headers: headers(agentBToken.token.secret, agentBSession),
        signal: streamBAbortController.signal,
      });
      expect(streamA.status).toBe(200);
      expect(streamB.status).toBe(200);
      const notificationA: Promise<string> = nextResourceUpdate(streamA);
      const notificationB: Promise<string> = nextResourceUpdate(streamB);

      const idempotencyKey: string = `same-key-${unique}`;
      const sentA: SendMessageOutput = await callTool(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        20,
        "send_message",
        {
          content: "tenant A message",
          idempotency_key: idempotencyKey,
          recipient_id: receiverA,
          sender_id: senderA,
        },
        SendMessageOutputSchema,
      );
      expect(
        await Promise.race([
          notificationA,
          Bun.sleep(3_000).then((): never => {
            throw new Error("Tenant A inbox notification timed out");
          }),
        ]),
      ).toBe(receiverAUri);
      const tenantBStayedQuiet: boolean = await Promise.race([
        notificationB.then((): boolean => false),
        Bun.sleep(250).then((): boolean => true),
      ]);
      expect(tenantBStayedQuiet).toBe(true);
      const sentB: SendMessageOutput = await callTool(
        server.mcpUrl,
        agentBToken.token.secret,
        agentBSession,
        21,
        "send_message",
        {
          content: "tenant B message",
          idempotency_key: idempotencyKey,
          recipient_id: receiverB,
          sender_id: senderB,
        },
        SendMessageOutputSchema,
      );
      expect(
        await Promise.race([
          notificationB,
          Bun.sleep(3_000).then((): never => {
            throw new Error("Tenant B inbox notification timed out");
          }),
        ]),
      ).toBe(receiverBUri);
      streamAAbortController.abort();
      streamBAbortController.abort();
      expect(sentA.message.content).toBe("tenant A message");
      expect(sentB.message.content).toBe("tenant B message");
      expect(sentA.message.sequence).toBe(1);
      expect(sentB.message.sequence).toBe(1);

      const broadcastA: BroadcastMessageOutput = await callTool(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        211,
        "broadcast_message",
        {
          audience: {},
          content: "tenant A organization broadcast",
          idempotency_key: `tenant-a-broadcast-${unique}`,
          sender_id: senderA,
        },
        BroadcastMessageOutputSchema,
      );
      expect(broadcastA.recipient_count).toBe(1);

      const agentsA: ListAgentsOutput = await callTool(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        22,
        "list_agents",
        {},
        ListAgentsOutputSchema,
      );
      expect(
        agentsA.agents.some(
          (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === senderA,
        ),
      ).toBe(true);
      expect(
        agentsA.agents.some(
          (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === receiverB,
        ),
      ).toBe(false);
      const inboxA: InboxOutput = await callTool(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        23,
        "get_messages",
        { agent_id: receiverA, limit: 100, unread_only: false },
        InboxOutputSchema,
      );
      expect(
        inboxA.messages.map((message: InboxOutput["messages"][number]): string => message.content),
      ).toEqual(["tenant A message", "tenant A organization broadcast"]);
      expect(
        inboxA.messages.map((message: InboxOutput["messages"][number]): number => message.sequence),
      ).toEqual([1, 2]);
      const inboxB: InboxOutput = await callTool(
        server.mcpUrl,
        agentBToken.token.secret,
        agentBSession,
        231,
        "get_messages",
        { agent_id: receiverB, limit: 100, unread_only: false },
        InboxOutputSchema,
      );
      expect(
        inboxB.messages.map((message: InboxOutput["messages"][number]): string => message.content),
      ).toEqual(["tenant B message"]);
      const crossReadError: string = await callToolExpectingError(
        server.mcpUrl,
        agentBToken.token.secret,
        agentBSession,
        24,
        "get_messages",
        { agent_id: receiverA, limit: 100, unread_only: false },
      );
      expect(crossReadError).toContain("Unknown agent");
      expect(crossReadError).not.toContain("tenant A message");

      const markedA: MarkMessagesReadOutput = await callTool(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        241,
        "mark_messages_read",
        {
          agent_id: receiverA,
          message_ids: inboxA.messages.map(
            (message: InboxOutput["messages"][number]): string => message.message_id,
          ),
        },
        MarkMessagesReadOutputSchema,
      );
      expect(markedA.updated).toBe(2);

      const crossRevoke: RevokeTokenOutput = await callTool(
        server.mcpUrl,
        tenantB.token.secret,
        adminBSession,
        25,
        "revoke_access_token",
        { key_id: agentAToken.token.key_id },
        RevokeTokenOutputSchema,
      );
      expect(crossRevoke.revoked).toBe(false);
      const revoked: RevokeTokenOutput = await callTool(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
        26,
        "revoke_access_token",
        { key_id: agentAToken.token.key_id },
        RevokeTokenOutputSchema,
      );
      expect(revoked.revoked).toBe(true);
      await Bun.sleep(20);
      const revokedRequest: Response = await post(
        server.mcpUrl,
        agentAToken.token.secret,
        agentASession,
        { id: 27, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      expect(revokedRequest.status).toBe(401);

      const subscriptionAgentIds: string[] = [];
      for (let index: number = 0; index < 11; index += 1) {
        const subscriptionAgentId: string = `hosted-subscription-${index}-${unique}`;
        subscriptionAgentIds.push(subscriptionAgentId);
        await callTool(
          server.mcpUrl,
          tenantA.token.secret,
          adminASession,
          500 + index,
          "register_agent",
          { agent_id: subscriptionAgentId, display_name: subscriptionAgentId },
          RegisterAgentOutputSchema,
        );
      }
      for (let index: number = 0; index < 10; index += 1) {
        const subscriptionAgentId: string | undefined = subscriptionAgentIds[index];
        if (subscriptionAgentId === undefined) throw new Error("Subscription agent is missing");
        await subscribeInbox(
          server.mcpUrl,
          tenantA.token.secret,
          adminASession,
          520 + index,
          `murmur://inbox/${subscriptionAgentId}`,
        );
      }
      expect(
        await subscribeInboxExpectingError(
          server.mcpUrl,
          tenantA.token.secret,
          adminASession,
          530,
          `murmur://inbox/${subscriptionAgentIds[10]}`,
        ),
      ).toContain("Inbox subscription capacity reached");

      const suspended: TenantStatusOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        28,
        "suspend_tenant",
        { tenant_id: tenantB.tenant.tenant_id },
        TenantStatusOutputSchema,
      );
      expect(suspended.changed).toBe(true);
      await Bun.sleep(20);
      const suspendedRequest: Response = await post(
        server.mcpUrl,
        tenantB.token.secret,
        adminBSession,
        { id: 29, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      expect(suspendedRequest.status).toBe(401);
      const restored: TenantStatusOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        30,
        "restore_tenant",
        { tenant_id: tenantB.tenant.tenant_id },
        TenantStatusOutputSchema,
      );
      expect(restored.changed).toBe(true);
      const audit: ListAdminAuditOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        31,
        "list_admin_audit",
        { limit: 100 },
        ListAdminAuditOutputSchema,
      );
      if (bootstrapLegacyToken !== undefined) {
        expect(
          audit.events.some(
            (event: ListAdminAuditOutput["events"][number]): boolean =>
              event.action === "operator.bootstrap",
          ),
        ).toBe(true);
      }
      expect(
        audit.events.some(
          (event: ListAdminAuditOutput["events"][number]): boolean =>
            event.action === "tenant.suspend",
        ),
      ).toBe(true);
      expect(
        await toolNames(
          server.mcpUrl,
          tenantB.token.secret,
          await initialize(server.mcpUrl, tenantB.token.secret, "tenant-b-restored-test"),
        ),
      ).toContain("register_agent");

      const foundingSuspended: TenantStatusOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        32,
        "suspend_tenant",
        { tenant_id: tenantA.tenant.tenant_id },
        TenantStatusOutputSchema,
      );
      expect(foundingSuspended.changed).toBe(true);
      await Bun.sleep(20);
      const foundingSuspendedRequest: Response = await post(
        server.mcpUrl,
        tenantA.token.secret,
        adminASession,
        { id: 33, jsonrpc: "2.0", method: "tools/list", params: {} },
      );
      expect(foundingSuspendedRequest.status).toBe(401);
      const foundingReplacement: IssuedTokenOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        34,
        "mint_tenant_admin_token",
        { name: "Founding tenant recovery", tenant_id: tenantA.tenant.tenant_id },
        IssuedTokenOutputSchema,
      );
      const foundingRestored: TenantStatusOutput = await callTool(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        35,
        "restore_tenant",
        { tenant_id: tenantA.tenant.tenant_id },
        TenantStatusOutputSchema,
      );
      expect(foundingRestored.changed).toBe(true);
      expect(
        await toolNames(
          server.mcpUrl,
          foundingReplacement.token.secret,
          await initialize(
            server.mcpUrl,
            foundingReplacement.token.secret,
            "founding-tenant-recovered-test",
          ),
        ),
      ).toContain("create_access_token");
    } finally {
      await server.stop();
    }
  },
  30_000,
);
