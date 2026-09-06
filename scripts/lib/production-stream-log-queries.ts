import { z } from "zod";

import {
  requireStreamLog,
  type StreamLogConfiguration,
  type StreamLogContext,
  type StreamLogResult,
} from "./production-stream-log-contracts.js";

const RevisionSchema: z.ZodString = z
  .string()
  .max(63)
  .regex(/^[a-z][a-z0-9-]+[a-z0-9](?![\s\S])/u);
type ServiceRecord = {
  readonly metadata: { readonly name: string };
  readonly status: {
    readonly latestReadyRevisionName: string;
    readonly traffic: {
      readonly revisionName: string;
      readonly percent: number;
      readonly tag?: string | undefined;
    }[];
  };
};
type ImageRecord = {
  readonly metadata: { readonly name: string };
  readonly spec: { readonly containers: { readonly image: string }[] };
};
type ArtifactRecord = {
  readonly image_summary: {
    readonly digest: string;
    readonly fully_qualified_digest: string;
  };
};
export type StreamRevisionImage =
  | { readonly kind: "tagged" }
  | { readonly kind: "digest-only"; readonly digest: string };
type ResourceRecord = {
  readonly type: "cloud_run_revision";
  readonly labels: {
    readonly project_id: string;
    readonly location: string;
    readonly service_name: string;
    readonly revision_name: string;
  };
};
type MetadataRecord = { readonly timestamp: string; readonly resource: ResourceRecord };
export type StreamApplicationLog = MetadataRecord & {
  readonly jsonPayload: {
    readonly event: "http.request.completed";
    readonly http_method: "GET";
    readonly http_route: "/mcp";
    readonly http_status_code: 200;
    readonly response_finish: "completed" | "cancelled";
    readonly session_hash: string;
    readonly request_id: string;
    readonly session_lookup: "found";
    readonly authentication: "authenticated";
    readonly principal_kind: "tenant";
    readonly stream_rotated: boolean;
    readonly duration_ms: number;
  };
};
type PlatformRecord = MetadataRecord & {
  readonly httpRequest: { readonly status: number; readonly latency?: string | undefined };
};
const ServiceSchema: z.ZodType<ServiceRecord> = z.strictObject({
  metadata: z.strictObject({ name: z.string().max(63) }),
  status: z.strictObject({
    latestReadyRevisionName: RevisionSchema,
    traffic: z
      .array(
        z.strictObject({
          revisionName: RevisionSchema,
          percent: z.number().int().min(0).max(100),
          tag: z.string().max(63).optional(),
        }),
      )
      .length(1),
  }),
});
const ImageSchema: z.ZodType<ImageRecord> = z.strictObject({
  metadata: z.strictObject({ name: RevisionSchema }),
  spec: z.strictObject({
    containers: z.array(z.strictObject({ image: z.string().max(512) })).length(1),
  }),
});
const DigestSchema: z.ZodString = z.string().regex(/^sha256:[0-9a-f]{64}(?![\s\S])/u);
const ArtifactSchema: z.ZodType<ArtifactRecord> = z.strictObject({
  image_summary: z.strictObject({
    digest: DigestSchema,
    fully_qualified_digest: z.string().max(512),
  }),
});

const ResourceSchema: z.ZodType<ResourceRecord> = z.strictObject({
  type: z.literal("cloud_run_revision"),
  labels: z.strictObject({
    project_id: z.string().max(63),
    location: z.string().max(63),
    service_name: z.string().max(63),
    revision_name: RevisionSchema,
  }),
});
const MetadataSchema: z.ZodType<MetadataRecord> = z.strictObject({
  timestamp: z.iso.datetime(),
  resource: ResourceSchema,
});
const ApplicationSchema: z.ZodType<StreamApplicationLog> = z.strictObject({
  timestamp: z.iso.datetime(),
  resource: ResourceSchema,
  jsonPayload: z.strictObject({
    event: z.literal("http.request.completed"),
    http_method: z.literal("GET"),
    http_route: z.literal("/mcp"),
    http_status_code: z.literal(200),
    response_finish: z.enum(["completed", "cancelled"]),
    session_hash: z.string().regex(/^[A-Za-z0-9_-]{22}(?![\s\S])/u),
    request_id: z.string().uuid().length(36),
    session_lookup: z.literal("found"),
    authentication: z.literal("authenticated"),
    principal_kind: z.literal("tenant"),
    stream_rotated: z.boolean(),
    duration_ms: z
      .number()
      .nonnegative()
      .finite()
      .max(65 * 60_000),
  }),
});
const PlatformSchema: z.ZodType<PlatformRecord> = z.strictObject({
  timestamp: z.iso.datetime(),
  resource: ResourceSchema,
  httpRequest: z.strictObject({
    status: z.number().int().min(500).max(599),
    latency: z
      .string()
      .max(40)
      .regex(/^\d+(\.\d{1,9})?s(?![\s\S])/u)
      .optional(),
  }),
});

const METADATA_FIELDS: string =
  "timestamp,resource.type,resource.labels.project_id,resource.labels.location,resource.labels.service_name,resource.labels.revision_name";
const APPLICATION_FIELDS: string = `${METADATA_FIELDS},jsonPayload.event,jsonPayload.http_method,jsonPayload.http_route,jsonPayload.http_status_code,jsonPayload.response_finish,jsonPayload.session_hash,jsonPayload.request_id,jsonPayload.session_lookup,jsonPayload.authentication,jsonPayload.principal_kind,jsonPayload.stream_rotated,jsonPayload.duration_ms`;

function commonArguments(config: StreamLogConfiguration): string[] {
  return ["--project", config.project, "--region", config.region, "--quiet", "--verbosity=error"];
}

export function streamServiceArguments(config: StreamLogConfiguration): string[] {
  return [
    "run",
    "services",
    "describe",
    config.service,
    ...commonArguments(config),
    "--format",
    "json(metadata.name,status.latestReadyRevisionName,status.traffic[].revisionName,status.traffic[].percent,status.traffic[].tag)",
  ];
}

export function streamRevisionArguments(
  config: StreamLogConfiguration,
  revision: string,
): string[] {
  return [
    "run",
    "revisions",
    "describe",
    revision,
    ...commonArguments(config),
    "--format",
    "json(metadata.name,spec.containers[].image)",
  ];
}

function streamImageName(config: StreamLogConfiguration): string {
  return `${config.region}-docker.pkg.dev/${config.project}/${config.repository}/${config.service}`;
}

export function streamArtifactArguments(config: StreamLogConfiguration): string[] {
  return [
    "artifacts",
    "docker",
    "images",
    "describe",
    `${streamImageName(config)}:${config.expectedSha}`,
    "--project",
    config.project,
    "--format",
    "json(image_summary.digest,image_summary.fully_qualified_digest)",
    "--quiet",
    "--verbosity=error",
  ];
}

export function validateStreamArtifact(
  value: unknown,
  config: StreamLogConfiguration,
  digest: string,
): void {
  const parsed: ReturnType<typeof ArtifactSchema.safeParse> = ArtifactSchema.safeParse(value);
  requireStreamLog(parsed.success);
  requireStreamLog(
    parsed.data.image_summary.digest === digest &&
      parsed.data.image_summary.fully_qualified_digest === `${streamImageName(config)}@${digest}`,
  );
}

export function streamServiceRevision(value: unknown, config: StreamLogConfiguration): string {
  const parsed: ReturnType<typeof ServiceSchema.safeParse> = ServiceSchema.safeParse(value);
  requireStreamLog(parsed.success);
  const traffic: (typeof parsed.data.status.traffic)[number] | undefined =
    parsed.data.status.traffic[0];
  requireStreamLog(traffic !== undefined);
  requireStreamLog(
    parsed.data.metadata.name === config.service &&
      traffic.percent === 100 &&
      traffic.tag === undefined,
  );
  const revision: string = parsed.data.status.latestReadyRevisionName;
  requireStreamLog(traffic.revisionName === revision && revision.startsWith(`${config.service}-`));
  return revision;
}

export function validateStreamRevision(
  value: unknown,
  config: StreamLogConfiguration,
  revision: string,
): StreamRevisionImage {
  const parsed: ReturnType<typeof ImageSchema.safeParse> = ImageSchema.safeParse(value);
  requireStreamLog(parsed.success && parsed.data.metadata.name === revision);
  const container: (typeof parsed.data.spec.containers)[number] | undefined =
    parsed.data.spec.containers[0];
  requireStreamLog(container !== undefined);
  const prefix: string = `${config.region}-docker.pkg.dev/${config.project}/${config.repository}/`;
  requireStreamLog(container.image.startsWith(prefix));
  const taggedImage: string = container.image.slice(prefix.length);
  if (taggedImage.startsWith(`${config.service}@`)) {
    const digest: string = taggedImage.slice(config.service.length + 1);
    requireStreamLog(DigestSchema.safeParse(digest).success);
    // Cloud Run may retain only the digest. Source-tag provenance must be checked separately.
    return { kind: "digest-only", digest };
  }
  const expectedTag: string = `${config.service}:${config.expectedSha}`;
  requireStreamLog(
    taggedImage === expectedTag ||
      (taggedImage.startsWith(`${expectedTag}@sha256:`) &&
        /^[0-9a-f]{64}(?![\s\S])/u.test(taggedImage.slice(expectedTag.length + 8))),
  );
  return { kind: "tagged" };
}

function scope(config: StreamLogConfiguration, revision: string): string {
  return `resource.type="cloud_run_revision" AND resource.labels.project_id="${config.project}" AND resource.labels.location="${config.region}" AND resource.labels.service_name="${config.service}" AND resource.labels.revision_name="${revision}"`;
}

function loggingArguments(
  config: StreamLogConfiguration,
  filter: string,
  fields: string,
): string[] {
  return [
    "logging",
    "read",
    filter,
    "--project",
    config.project,
    "--limit",
    "2",
    "--order",
    "asc",
    "--format",
    `json(${fields})`,
    "--quiet",
    "--verbosity=error",
  ];
}

export function streamAccessArguments(
  config: StreamLogConfiguration,
  revision: string,
  since: string,
): string[] {
  return loggingArguments(
    config,
    `${scope(config, revision)} AND timestamp>="${since}"`,
    METADATA_FIELDS,
  );
}

export function streamObservationArguments(
  context: StreamLogContext,
  result: StreamLogResult,
  kind: "initial" | "replacement" | "platform",
): string[] {
  const lower: string = new Date(Date.parse(result.startedAt) - 30_000).toISOString();
  const upper: string = new Date(Date.parse(result.endedAt) + 30_000).toISOString();
  const window: string = `${scope(context, context.revision)} AND timestamp>="${lower}" AND timestamp<="${upper}"`;
  if (kind === "platform") {
    return loggingArguments(
      context,
      `${window} AND logName="projects/${context.project}/logs/run.googleapis.com%2Frequests" AND httpRequest.status>=500`,
      `${METADATA_FIELDS},httpRequest.status,httpRequest.latency`,
    );
  }
  const requestId: string =
    kind === "initial" ? result.initialRequestId : result.replacementRequestId;
  const filter: string = `${window} AND jsonPayload.event="http.request.completed" AND jsonPayload.http_method="GET" AND jsonPayload.http_route="/mcp" AND jsonPayload.http_status_code=200 AND jsonPayload.session_hash="${result.sessionHash}" AND jsonPayload.request_id="${requestId}"`;
  return loggingArguments(context, filter, APPLICATION_FIELDS);
}

function validateMetadata(
  row: MetadataRecord,
  config: StreamLogConfiguration,
  revision: string,
): void {
  requireStreamLog(
    row.resource.labels.project_id === config.project &&
      row.resource.labels.location === config.region &&
      row.resource.labels.service_name === config.service &&
      row.resource.labels.revision_name === revision,
  );
}

export function validateStreamAccess(
  value: unknown,
  config: StreamLogConfiguration,
  revision: string,
): void {
  const parsed: ReturnType<z.ZodArray<typeof MetadataSchema>["safeParse"]> = z
    .array(MetadataSchema)
    .max(2)
    .safeParse(value);
  requireStreamLog(parsed.success);
  for (const row of parsed.data) validateMetadata(row, config, revision);
}

export function parseStreamApplication(
  value: unknown,
  context: StreamLogContext,
  result: StreamLogResult,
  initial: boolean,
): StreamApplicationLog | null {
  const parsed: ReturnType<z.ZodArray<typeof ApplicationSchema>["safeParse"]> = z
    .array(ApplicationSchema)
    .max(1)
    .safeParse(value);
  requireStreamLog(parsed.success);
  const row: StreamApplicationLog | undefined = parsed.data[0];
  if (row === undefined) return null;
  validateMetadata(row, context, context.revision);
  const timestamp: number = Date.parse(row.timestamp);
  requireStreamLog(
    timestamp >= Date.parse(result.startedAt) - 30_000 &&
      timestamp <= Date.parse(result.endedAt) + 30_000,
  );
  const payload: StreamApplicationLog["jsonPayload"] = row.jsonPayload;
  requireStreamLog(
    payload.session_hash === result.sessionHash &&
      payload.request_id === (initial ? result.initialRequestId : result.replacementRequestId),
  );
  if (initial) {
    requireStreamLog(payload.stream_rotated && payload.response_finish === "completed");
    requireStreamLog(
      payload.duration_ms >= 49.5 * 60_000 && payload.duration_ms <= 55 * 60_000 + 30_000,
    );
    requireStreamLog(
      Math.abs(timestamp - payload.duration_ms - Date.parse(result.startedAt)) <= 30_000,
    );
  } else requireStreamLog(!payload.stream_rotated);
  return row;
}

export function validateStreamPlatform(value: unknown, context: StreamLogContext): void {
  const parsed: ReturnType<z.ZodArray<typeof PlatformSchema>["safeParse"]> = z
    .array(PlatformSchema)
    .max(2)
    .safeParse(value);
  requireStreamLog(parsed.success);
  for (const row of parsed.data) validateMetadata(row, context, context.revision);
  // This is an existence query, never an inventory: any matching failure rejects the window.
  requireStreamLog(parsed.data.length === 0);
}
