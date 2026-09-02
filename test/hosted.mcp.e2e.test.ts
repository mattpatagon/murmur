import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  type BootstrapCredential,
  deriveBootstrapCredential,
} from "../src/hosted/bootstrap-secret.js";
import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type IssuedOperatorTokenOutput,
  IssuedOperatorTokenOutputSchema,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type ListOperatorTokensOutput,
  ListOperatorTokensOutputSchema,
  type RevokeTokenOutput,
  RevokeTokenOutputSchema,
  type TenantStatusOutput,
  TenantStatusOutputSchema,
} from "../src/hosted/contracts.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import {
  verifyHostedAgentLifecycleProtocol,
  verifyHostedAgentLifecycleStorage,
} from "./scenarios/hosted-agent-lifecycle.js";
import { verifyHostedAgentLifecycleHardening } from "./scenarios/hosted-agent-lifecycle-hardening.js";
import { verifyHostedE2ee } from "./scenarios/hosted-e2ee.js";
import { verifyHostedFeedback } from "./scenarios/hosted-feedback.js";
import {
  type HostedOrchestrationResult,
  verifyHostedOrchestration,
} from "./scenarios/hosted-orchestration.js";
import { verifyHostedOrchestrationRollback } from "./scenarios/hosted-orchestration-rollback.js";
import { verifyHostedTenantLifecycle } from "./scenarios/hosted-tenant-lifecycle.js";
import { verifyHostedTenantMessaging } from "./scenarios/hosted-tenant-messaging.js";
import {
  type HostedTenantScenario,
  provisionHostedTenantScenario,
} from "./scenarios/hosted-tenant-provisioning.js";
import { verifyHostedTenantQuotas } from "./scenarios/hosted-tenant-quotas.js";
import {
  adminDatabaseUrl,
  bootstrapLegacyToken,
  callTool,
  callToolExpectingError,
  configureBootstrap,
  databaseUrl,
  existingOperatorToken,
  finalizeTenantContract,
  initialize,
  operatorSecret,
  post,
  testTlsConfiguration,
  toolNames,
} from "./support/hosted-mcp-harness.js";

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
        const legacyCreatedToken: IssuedTokenOutput = await callTool(
          server.mcpUrl,
          bootstrapLegacyToken,
          v1FoundingSession,
          43,
          "create_access_token",
          { name: "Legacy-created rotation token", role: "agent" },
          IssuedTokenOutputSchema,
        );
        expect(legacyCreatedToken.token.role).toBe("agent");
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

      const selfServiceSlug: string = `self-service-${unique}`;
      const selfServiceRegistrationSecret: string = randomBytes(32).toString("base64url");
      const selfServiceBody: string = JSON.stringify({
        display_name: `Self-service tenant ${unique}`,
        registration_secret: selfServiceRegistrationSecret,
        slug: selfServiceSlug,
      });
      const selfServiceResponse: Response = await fetch(server.registrationUrl, {
        body: selfServiceBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(selfServiceResponse.status).toBe(201);
      expect(selfServiceResponse.headers.get("cache-control")).toBe("no-store");
      const selfServiceTenant: CreateTenantOutput = CreateTenantOutputSchema.parse(
        await selfServiceResponse.json(),
      );
      expect(selfServiceTenant.tenant.slug).toBe(selfServiceSlug);
      expect(selfServiceTenant.token.role).toBe("tenant_admin");
      const selfServiceSession: string = await initialize(
        server.mcpUrl,
        selfServiceTenant.token.secret,
        "self-service-tenant-test",
      );
      const selfServiceTools: readonly string[] = await toolNames(
        server.mcpUrl,
        selfServiceTenant.token.secret,
        selfServiceSession,
      );
      expect(selfServiceTools).toContain("register_agent");
      expect(selfServiceTools).toContain("create_access_token");
      expect(selfServiceTools).not.toContain("create_tenant");
      const replayedSelfServiceResponse: Response = await fetch(server.registrationUrl, {
        body: selfServiceBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(replayedSelfServiceResponse.status).toBe(201);
      expect(CreateTenantOutputSchema.parse(await replayedSelfServiceResponse.json())).toEqual(
        selfServiceTenant,
      );
      const duplicateSelfServiceResponse: Response = await fetch(server.registrationUrl, {
        body: JSON.stringify({
          display_name: `Duplicate self-service tenant ${unique}`,
          registration_secret: randomBytes(32).toString("base64url"),
          slug: selfServiceSlug,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(duplicateSelfServiceResponse.status).toBe(409);
      expect(await duplicateSelfServiceResponse.json()).toEqual({
        error: "Tenant slug is already registered",
      });
      const conflictingReplayResponse: Response = await fetch(server.registrationUrl, {
        body: JSON.stringify({
          display_name: `Conflicting self-service tenant ${unique}`,
          registration_secret: selfServiceRegistrationSecret,
          slug: `conflicting-${unique}`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(conflictingReplayResponse.status).toBe(409);
      expect(await conflictingReplayResponse.json()).toEqual({
        error: "Registration secret was already used with different tenant details",
      });

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
      expect(operatorDataError).toContain("Unknown tool");
      const operatorBootstrapError: string = await callToolExpectingError(
        server.mcpUrl,
        operatorToken,
        operatorSession,
        711,
        "bootstrap_operator",
        { name: "Forbidden bootstrap" },
      );
      expect(operatorBootstrapError).toContain("Unknown tool");

      const scenario: HostedTenantScenario = await provisionHostedTenantScenario({
        configuredAdminDatabaseUrl,
        operatorSession,
        operatorToken,
        server,
        unique,
      });
      await verifyHostedTenantQuotas(scenario);
      await verifyHostedFeedback(scenario);
      await verifyHostedTenantMessaging(scenario);
      await verifyHostedAgentLifecycleProtocol(scenario);
      const orchestration: HostedOrchestrationResult = await verifyHostedOrchestration(scenario);
      await verifyHostedOrchestrationRollback(configuredDatabaseUrl, orchestration);
      await verifyHostedTenantLifecycle(scenario);
      await verifyHostedAgentLifecycleStorage(scenario);
      await verifyHostedAgentLifecycleHardening(scenario);
      await verifyHostedE2ee(scenario);
    } finally {
      await server.stop();
    }
  },
  120_000,
);
