import { z } from "zod";

import { MurmurVersionSchema } from "../../src/domain/upgrade-contracts.js";

export const STREAM_LOG_MAX_BYTES: number = 65_536;
export const STREAM_LOG_CONTEXT_FILE: string = "murmur-production-stream-context.json";
export const STREAM_LOG_RESULT_FILE: string = "murmur-production-stream-result.jsonl";
export const STREAM_LOG_MINIMUM_MS: number = 55 * 60_000;

export class ProductionStreamLogFailure extends Error {
  public constructor() {
    super("Production stream log verification failed");
    this.name = ProductionStreamLogFailure.name;
  }
}

export function requireStreamLog(condition: unknown): asserts condition {
  if (!condition) throw new ProductionStreamLogFailure();
}

const ShaSchema: z.ZodString = z.string().regex(/^[0-9a-f]{40}(?![\s\S])/u);
const NameSchema: z.ZodString = z
  .string()
  .max(63)
  .regex(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?(?![\s\S])/u);
const VersionSchema: z.ZodString = MurmurVersionSchema.regex(/^[0-9.]+(?![\s\S])/u);
const TimestampSchema: z.ZodType<string> = z.iso.datetime();

export const StreamLogConfigurationSchema: z.ZodType<StreamLogConfiguration> = z.strictObject({
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9](?![\s\S])/u),
  region: z.string().regex(/^[a-z]+(-[a-z]+)+[0-9]+(?![\s\S])/u),
  service: NameSchema,
  repository: z.string().regex(/^[a-z]([a-z0-9._-]{0,61}[a-z0-9])?(?![\s\S])/u),
  expectedSha: ShaSchema,
  expectedVersion: VersionSchema,
  origin: z.string().max(2_048),
});

export type StreamLogConfiguration = {
  readonly project: string;
  readonly region: string;
  readonly service: string;
  readonly repository: string;
  readonly expectedSha: string;
  readonly expectedVersion: string;
  readonly origin: string;
};

export type StreamLogContext = {
  readonly schema_version: 1;
  readonly project: string;
  readonly region: string;
  readonly service: string;
  readonly repository: string;
  readonly expectedSha: string;
  readonly expectedVersion: string;
  readonly origin: string;
  readonly revision: string;
  readonly version: string;
  readonly checkedAt: string;
};

export const StreamLogContextSchema: z.ZodType<StreamLogContext> = z.strictObject({
  schema_version: z.literal(1),
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9](?![\s\S])/u),
  region: z.string().regex(/^[a-z]+(-[a-z]+)+[0-9]+(?![\s\S])/u),
  service: NameSchema,
  repository: z.string().regex(/^[a-z]([a-z0-9._-]{0,61}[a-z0-9])?(?![\s\S])/u),
  expectedSha: ShaSchema,
  expectedVersion: VersionSchema,
  origin: z.string().max(2_048),
  revision: NameSchema,
  version: VersionSchema,
  checkedAt: TimestampSchema,
});

export const StreamLogReleaseSchema: z.ZodType<{
  readonly revision: string;
  readonly version: string;
}> = z.strictObject({ revision: ShaSchema, version: VersionSchema });

export const StreamLogResultSchema: z.ZodType<StreamLogResult> = z.strictObject({
  event: z.literal("production-stream-result"),
  passed: z.literal(true),
  expectedSha: ShaSchema,
  expectedVersion: VersionSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  observedMilliseconds: z
    .number()
    .int()
    .safe()
    .min(STREAM_LOG_MINIMUM_MS)
    .max(65 * 60_000),
  sessionHash: z.string().regex(/^[A-Za-z0-9_-]{22}(?![\s\S])/u),
  initialRequestId: z.string().uuid().length(36),
  replacementRequestId: z.string().uuid().length(36),
  successfulGetResponses: z.number().int().min(2).max(4),
  initializationCount: z.literal(1),
  sameSession: z.literal(true),
  notification: z.literal(true),
  durableInbox: z.literal(true),
  streamClosed: z.literal(true),
  cleanupPassed: z.literal(true),
  cleanup: z.strictObject({
    worker_revoked: z.literal(true),
    worker_unauthorized: z.literal(true),
    administrator_revoked: z.literal(true),
    administrator_unauthorized: z.literal(true),
    tenant_suspended: z.literal(true),
    connections_closed: z.literal(true),
  }),
  failure: z.null(),
});

export type StreamLogResult = {
  readonly event: "production-stream-result";
  readonly passed: true;
  readonly expectedSha: string;
  readonly expectedVersion: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly observedMilliseconds: number;
  readonly sessionHash: string;
  readonly initialRequestId: string;
  readonly replacementRequestId: string;
  readonly successfulGetResponses: number;
  readonly initializationCount: 1;
  readonly sameSession: true;
  readonly notification: true;
  readonly durableInbox: true;
  readonly streamClosed: true;
  readonly cleanupPassed: true;
  readonly cleanup: {
    readonly worker_revoked: true;
    readonly worker_unauthorized: true;
    readonly administrator_revoked: true;
    readonly administrator_unauthorized: true;
    readonly tenant_suspended: true;
    readonly connections_closed: true;
  };
  readonly failure: null;
};

const ProgressSchema: z.ZodType<{
  readonly event: "production-stream-progress";
  readonly elapsedMilliseconds: number;
}> = z.strictObject({
  event: z.literal("production-stream-progress"),
  elapsedMilliseconds: z
    .number()
    .int()
    .safe()
    .min(0)
    .max(65 * 60_000),
});

export function parseStreamLogResult(text: string): StreamLogResult {
  requireStreamLog(Buffer.byteLength(text, "utf8") <= STREAM_LOG_MAX_BYTES);
  const lines: string[] = text.trim().split("\n");
  requireStreamLog(lines.length > 0 && lines.length <= 67);
  let result: StreamLogResult | null = null;
  let priorElapsed: number = -1;
  for (const line of lines) {
    requireStreamLog(result === null);
    const value: unknown = streamLogJson(line);
    const progress: ReturnType<typeof ProgressSchema.safeParse> = ProgressSchema.safeParse(value);
    if (progress.success) {
      requireStreamLog(progress.data.elapsedMilliseconds > priorElapsed);
      priorElapsed = progress.data.elapsedMilliseconds;
      continue;
    }
    const parsed: z.ZodSafeParseResult<StreamLogResult> = StreamLogResultSchema.safeParse(value);
    requireStreamLog(parsed.success);
    result = parsed.data;
  }
  requireStreamLog(result !== null && priorElapsed <= result.observedMilliseconds);
  return result;
}

export function streamLogJson(text: string): unknown {
  requireStreamLog(Buffer.byteLength(text, "utf8") <= STREAM_LOG_MAX_BYTES);
  try {
    return JSON.parse(text);
  } catch (_error: unknown) {
    throw new ProductionStreamLogFailure();
  }
}

export function validateStreamLogConfiguration(value: unknown): StreamLogConfiguration {
  const parsed: z.ZodSafeParseResult<StreamLogConfiguration> =
    StreamLogConfigurationSchema.safeParse(value);
  requireStreamLog(parsed.success);
  let origin: URL;
  try {
    origin = new URL(parsed.data.origin);
  } catch (_error: unknown) {
    throw new ProductionStreamLogFailure();
  }
  requireStreamLog(
    origin.protocol === "https:" && origin.username === "" && origin.password === "",
  );
  requireStreamLog(origin.pathname === "/" && origin.search === "" && origin.hash === "");
  requireStreamLog(
    parsed.data.origin === origin.origin || parsed.data.origin === `${origin.origin}/`,
  );
  return { ...parsed.data, origin: origin.origin };
}
