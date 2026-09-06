import { expect, test } from "bun:test";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { ProductionStreamApproval } from "../scripts/lib/production-stream-client.js";
import type {
  ProductionStreamConfig,
  ProductionStreamRuntime,
} from "../scripts/lib/production-stream-contracts.js";
import {
  checkProductionStreamHealth,
  productionStreamConfig,
} from "../scripts/lib/production-stream-health.js";
import { PRODUCTION_STREAM_CLOCK } from "../scripts/lib/production-stream-io.js";
import { approvalRequestDigest, HUMAN_APPROVAL_META_KEY } from "../src/admin/approval-request.js";

const ENVIRONMENT: NodeJS.ProcessEnv = {
  MURMUR_VERIFY_PRODUCTION_STREAM: "1",
  MURMUR_LIVE_URL: "https://observer.invalid/mcp",
  MURMUR_LIVE_EXPECTED_SHA: "a".repeat(40),
  MURMUR_LIVE_EXPECTED_VERSION: "0.14.0.0",
  MURMUR_LIVE_OPERATOR_TOKEN: `mur_op_testkey1_${"a".repeat(43)}`,
};

test("production configuration accepts Murmur's actual four-part version and requires explicit scope", (): void => {
  expect(productionStreamConfig(ENVIRONMENT).expectedVersion).toBe("0.14.0.0");
  for (const override of [
    { MURMUR_VERIFY_PRODUCTION_STREAM: "0" },
    { MURMUR_LIVE_URL: "http://observer.invalid/mcp" },
    { MURMUR_LIVE_URL: "https://secret@observer.invalid/mcp" },
    { MURMUR_LIVE_URL: "https://observer.invalid/mcp?secret=x" },
    { MURMUR_LIVE_EXPECTED_SHA: `${"a".repeat(40)}\n` },
    { MURMUR_LIVE_EXPECTED_VERSION: "0.14.0" },
    { MURMUR_LIVE_EXPECTED_VERSION: "0.14.0.0\n" },
  ])
    expect((): void => {
      productionStreamConfig({ ...ENVIRONMENT, ...override });
    }).toThrow();
});

for (const mode of ["valid", "wrong-sha", "wrong-version", "html", "unhealthy"]) {
  test(`periodic production health validates exact SHA/version: ${mode}`, async (): Promise<void> => {
    const config: ProductionStreamConfig = productionStreamConfig(ENVIRONMENT);
    const paths: string[] = [];
    const runtime: ProductionStreamRuntime = {
      clock: PRODUCTION_STREAM_CLOCK,
      fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
        expect(init === undefined ? undefined : init.redirect).toBe("error");
        const path: string = new URL(input).pathname;
        paths.push(path);
        if (mode === "html")
          return new Response("<html>private diagnostic</html>", { status: 500 });
        if (path === "/health")
          return Response.json({
            service: "murmur",
            status: mode === "unhealthy" ? "broken" : "ok",
          });
        return Response.json({
          revision: (mode === "wrong-sha" ? "b" : "a").repeat(40),
          version: mode === "wrong-version" ? "0.13.0.0" : "0.14.0.0",
        });
      },
    };
    if (mode === "valid") {
      await checkProductionStreamHealth(config, runtime);
      expect(paths).toEqual(["/health", "/version"]);
    } else await expect(checkProductionStreamHealth(config, runtime)).rejects.toThrow();
  });
}

function request(name: string, input: unknown): ElicitRequest {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Test approval",
      requestedSchema: {
        type: "object",
        properties: {
          confirmation: { type: "string", enum: ["approve:10000000-0000-4000-8000-000000000001"] },
        },
      },
      _meta: {
        [HUMAN_APPROVAL_META_KEY]: {
          operation: name,
          request_digest: approvalRequestDigest(name, input),
        },
      },
    },
  };
}

test("approval is limited to the exact in-flight tool and immutable arguments, then consumed", async (): Promise<void> => {
  const approval: ProductionStreamApproval = new ProductionStreamApproval();
  const input: Record<string, unknown> = { key_id: "owned-key" };
  const expected: ElicitRequest = request("revoke_access_token", input);
  expect(approval.answer(expected).action).toBe("decline");
  const answer: ElicitResult = await approval.run(
    "revoke_access_token",
    input,
    async (exact: Record<string, unknown>): Promise<ElicitResult> => {
      input["key_id"] = "foreign-key";
      expect(exact["key_id"]).toBe("owned-key");
      expect(approval.answer(request("suspend_tenant", { tenant_id: "foreign" })).action).toBe(
        "decline",
      );
      expect(approval.answer(request("revoke_access_token", input)).action).toBe("decline");
      const accepted: ElicitResult = approval.answer(expected);
      expect(approval.answer(expected).action).toBe("decline");
      return accepted;
    },
  );
  expect(answer.action).toBe("accept");
  expect(approval.answer(expected).action).toBe("decline");
});
