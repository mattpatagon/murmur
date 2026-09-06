import type { z } from "zod";

import {
  ProductionStreamLogFailure,
  parseStreamLogResult,
  requireStreamLog,
  STREAM_LOG_MINIMUM_MS,
  type StreamLogConfiguration,
  type StreamLogContext,
  StreamLogContextSchema,
  StreamLogReleaseSchema,
  type StreamLogResult,
  validateStreamLogConfiguration,
} from "./production-stream-log-contracts.js";
import { StreamLogDeadline, type StreamLogRuntime } from "./production-stream-log-process.js";
import {
  parseStreamApplication,
  type StreamApplicationLog,
  type StreamRevisionImage,
  streamAccessArguments,
  streamArtifactArguments,
  streamObservationArguments,
  streamRevisionArguments,
  streamServiceArguments,
  streamServiceRevision,
  validateStreamAccess,
  validateStreamArtifact,
  validateStreamPlatform,
  validateStreamRevision,
} from "./production-stream-log-queries.js";

const LOG_SETTLEMENT_MS: number = 120_000;

async function deployedContext(
  config: StreamLogConfiguration,
  runtime: StreamLogRuntime,
  deadline: StreamLogDeadline,
): Promise<StreamLogContext> {
  const service: unknown = await deadline.command(streamServiceArguments(config));
  const revision: string = streamServiceRevision(service, config);
  const image: StreamRevisionImage = validateStreamRevision(
    await deadline.command(streamRevisionArguments(config, revision)),
    config,
    revision,
  );
  if (image.kind === "digest-only") {
    validateStreamArtifact(
      await deadline.command(streamArtifactArguments(config)),
      config,
      image.digest,
    );
  }
  const release: ReturnType<typeof StreamLogReleaseSchema.safeParse> =
    StreamLogReleaseSchema.safeParse(
      await runtime.release(config.origin, deadline.remaining(10_000)),
    );
  deadline.remaining();
  requireStreamLog(
    release.success &&
      release.data.revision === config.expectedSha &&
      release.data.version === config.expectedVersion,
  );
  return {
    ...config,
    schema_version: 1,
    revision,
    version: release.data.version,
    checkedAt: runtime.timestamp(),
  };
}

export async function preflightProductionStreamLogs(
  configuration: unknown,
  runtime: StreamLogRuntime,
): Promise<StreamLogContext> {
  try {
    const config: StreamLogConfiguration = validateStreamLogConfiguration(configuration);
    const deadline: StreamLogDeadline = new StreamLogDeadline(runtime, 120_000);
    const context: StreamLogContext = await deployedContext(config, runtime, deadline);
    const since: string = new Date(Date.parse(runtime.timestamp()) - 60_000).toISOString();
    validateStreamAccess(
      await deadline.command(streamAccessArguments(config, context.revision, since)),
      config,
      context.revision,
    );
    return context;
  } catch (_error: unknown) {
    throw new ProductionStreamLogFailure();
  }
}

function validatedEvidence(
  config: StreamLogConfiguration,
  contextValue: unknown,
  resultText: string,
  runtime: StreamLogRuntime,
): { readonly context: StreamLogContext; readonly result: StreamLogResult } {
  const parsed: z.ZodSafeParseResult<StreamLogContext> =
    StreamLogContextSchema.safeParse(contextValue);
  requireStreamLog(parsed.success);
  const context: StreamLogContext = parsed.data;
  const keys: readonly (keyof StreamLogConfiguration)[] = [
    "project",
    "region",
    "service",
    "repository",
    "expectedSha",
    "expectedVersion",
    "origin",
  ];
  for (const key of keys) {
    requireStreamLog(context[key] === config[key]);
  }
  const result: StreamLogResult = parseStreamLogResult(resultText);
  requireStreamLog(
    result.expectedSha === config.expectedSha && result.expectedVersion === context.version,
  );
  requireStreamLog(result.initialRequestId !== result.replacementRequestId);
  const start: number = Date.parse(result.startedAt);
  const end: number = Date.parse(result.endedAt);
  const now: number = Date.parse(runtime.timestamp());
  const checked: number = Date.parse(context.checkedAt);
  requireStreamLog(start >= checked - 30_000 && start <= checked + 15 * 60_000);
  requireStreamLog(end - start >= STREAM_LOG_MINIMUM_MS && end - start <= 65 * 60_000);
  requireStreamLog(end <= now + 30_000 && end >= now - 15 * 60_000);
  return { context, result };
}

function requireSameDeployment(actual: StreamLogContext, expected: StreamLogContext): void {
  requireStreamLog(actual.revision === expected.revision && actual.version === expected.version);
}

export type StreamLogVerification = {
  readonly event: "production-stream-logs-verified";
  readonly expectedSha: string;
  readonly version: string;
  readonly revision: string;
  readonly sessionHash: string;
  readonly application_rotation: true;
  readonly same_session_reconnect: true;
  readonly platform_5xx_absent_in_observed_window: true;
  readonly log_settlement_ms: number;
};

export async function verifyProductionStreamLogs(
  configuration: unknown,
  contextValue: unknown,
  resultText: string,
  runtime: StreamLogRuntime,
): Promise<StreamLogVerification> {
  try {
    const config: StreamLogConfiguration = validateStreamLogConfiguration(configuration);
    const evidence: ReturnType<typeof validatedEvidence> = validatedEvidence(
      config,
      contextValue,
      resultText,
      runtime,
    );
    const context: StreamLogContext = evidence.context;
    const result: StreamLogResult = evidence.result;
    const deadline: StreamLogDeadline = new StreamLogDeadline(runtime, 6 * 60_000);
    requireSameDeployment(await deployedContext(config, runtime, deadline), context);
    for (let attempt: number = 0; attempt < 20; attempt += 1) {
      const initial: StreamApplicationLog | null = parseStreamApplication(
        await deadline.command(streamObservationArguments(context, result, "initial")),
        context,
        result,
        true,
      );
      const replacement: StreamApplicationLog | null = parseStreamApplication(
        await deadline.command(streamObservationArguments(context, result, "replacement")),
        context,
        result,
        false,
      );
      validateStreamPlatform(
        await deadline.command(streamObservationArguments(context, result, "platform")),
        context,
      );
      if (initial !== null && replacement !== null) {
        requireStreamLog(Date.parse(replacement.timestamp) > Date.parse(initial.timestamp));
        const reconnectDelay: number =
          Date.parse(replacement.timestamp) -
          replacement.jsonPayload.duration_ms -
          Date.parse(initial.timestamp);
        requireStreamLog(reconnectDelay >= -1_000 && reconnectDelay <= 30_000);
        if (Date.parse(runtime.timestamp()) >= Date.parse(result.endedAt) + LOG_SETTLEMENT_MS) {
          requireSameDeployment(await deployedContext(config, runtime, deadline), context);
          return {
            event: "production-stream-logs-verified",
            expectedSha: config.expectedSha,
            version: context.version,
            revision: context.revision,
            sessionHash: result.sessionHash,
            application_rotation: true,
            same_session_reconnect: true,
            platform_5xx_absent_in_observed_window: true,
            log_settlement_ms: LOG_SETTLEMENT_MS,
          };
        }
      }
      if (attempt < 19) await deadline.pause(15_000);
    }
    throw new ProductionStreamLogFailure();
  } catch (_error: unknown) {
    throw new ProductionStreamLogFailure();
  }
}
