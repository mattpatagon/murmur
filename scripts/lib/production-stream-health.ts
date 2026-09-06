import { z } from "zod";
import {
  MurmurReleaseMetadataSchema,
  MurmurRevisionSchema,
  MurmurVersionSchema,
} from "../../src/domain/upgrade-contracts.js";
import { OperatorTokenSecretSchema } from "../../src/hosted/token-secret.js";
import {
  type ProductionStreamConfig,
  type ProductionStreamRuntime,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamJsonRequest } from "./production-stream-io.js";

const HealthSchema: z.ZodType<{ readonly service: "murmur"; readonly status: "ok" }> =
  z.strictObject({ service: z.literal("murmur"), status: z.literal("ok") });

export function productionStreamConfig(environment: NodeJS.ProcessEnv): ProductionStreamConfig {
  const endpoint: URL = new URL(z.string().parse(environment["MURMUR_LIVE_URL"]));
  requireProductionStream(
    environment["MURMUR_VERIFY_PRODUCTION_STREAM"] === "1" &&
      endpoint.protocol === "https:" &&
      endpoint.pathname === "/mcp" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === "",
  );
  const expectedSha: string = MurmurRevisionSchema.parse(environment["MURMUR_LIVE_EXPECTED_SHA"]);
  const expectedVersion: string = MurmurVersionSchema.parse(
    environment["MURMUR_LIVE_EXPECTED_VERSION"],
  );
  requireProductionStream(expectedSha.length === 40 && expectedVersion.trim() === expectedVersion);
  return {
    endpoint,
    expectedSha,
    expectedVersion,
    operatorToken: OperatorTokenSecretSchema.parse(environment["MURMUR_LIVE_OPERATOR_TOKEN"]),
  };
}

export async function checkProductionStreamHealth(
  config: ProductionStreamConfig,
  runtime: ProductionStreamRuntime,
  signal?: AbortSignal,
): Promise<void> {
  const health: { readonly status: number; readonly value: unknown } = await streamJsonRequest(
    runtime.fetch,
    new URL("/health", config.endpoint),
    {},
    signal,
  );
  requireProductionStream(health.status === 200);
  HealthSchema.parse(health.value);
  const release: { readonly status: number; readonly value: unknown } = await streamJsonRequest(
    runtime.fetch,
    new URL("/version", config.endpoint),
    {},
    signal,
  );
  requireProductionStream(release.status === 200);
  const parsed: { readonly revision: string; readonly version: string } =
    MurmurReleaseMetadataSchema.parse(release.value);
  requireProductionStream(
    parsed.revision === config.expectedSha && parsed.version === config.expectedVersion,
  );
}
