import { randomUUID } from "node:crypto";

import { z } from "zod";

const AgentIdValueSchema: z.ZodString = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    "Use letters, numbers, dots, underscores, colons, or hyphens",
  );
const DisplayNameValueSchema: z.ZodString = z.string().trim().min(1).max(200);
const MessageContentValueSchema: z.ZodString = z.string().min(1).max(100_000);
const MessageIdValueSchema: z.ZodString = z.string().uuid();
const BroadcastIdValueSchema: z.ZodString = z.string().uuid();
const ThreadIdValueSchema: z.ZodString = z.string().trim().min(1).max(200);
const IdempotencyKeyValueSchema: z.ZodString = z.string().trim().min(1).max(200);
const RepositoryNameValueSchema: z.ZodString = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u,
    "Use a slash-separated repository path such as owner/repository",
  );
const BranchNameValueSchema: z.ZodString = z.string().trim().min(1).max(500);
const AgentClientValueSchema: z.ZodEnum<{
  claude: "claude";
  codex: "codex";
}> = z.enum(["claude", "codex"]);
const MachineNameValueSchema: z.ZodString = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Use letters, numbers, dots, underscores, or hyphens");
const SequenceValueSchema: z.ZodNumber = z.number().int().nonnegative().safe();
const InstantValueSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const TenantIdValueSchema: z.ZodString = z.string().uuid();

export const FOUNDING_TENANT_ID: string = "00000000-0000-4000-8000-000000000001";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

const MAX_METADATA_BYTES: number = 16 * 1024;
const MAX_METADATA_DEPTH: number = 5;
const MAX_METADATA_CONTAINER_ENTRIES: number = 100;

function validateJsonValueBounds(
  value: JsonValue,
  depth: number,
  context: z.core.$RefinementCtx<JsonObject>,
): void {
  if (depth > MAX_METADATA_DEPTH) {
    context.addIssue({
      code: "custom",
      message: `Metadata depth exceeds ${MAX_METADATA_DEPTH}`,
    });
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_CONTAINER_ENTRIES) {
      context.addIssue({
        code: "custom",
        message: `Metadata arrays may contain at most ${MAX_METADATA_CONTAINER_ENTRIES} values`,
      });
      return;
    }
    value.forEach((nested: JsonValue): void => {
      validateJsonValueBounds(nested, depth + 1, context);
    });
    return;
  }
  const entries: [string, JsonValue][] = Object.entries(value);
  if (entries.length > MAX_METADATA_CONTAINER_ENTRIES) {
    context.addIssue({
      code: "custom",
      message: `Metadata objects may contain at most ${MAX_METADATA_CONTAINER_ENTRIES} keys`,
    });
    return;
  }
  entries.forEach((entry: [string, JsonValue]): void => {
    validateJsonValueBounds(entry[1], depth + 1, context);
  });
}

function validateJsonObjectBounds(
  value: JsonObject,
  context: z.core.$RefinementCtx<JsonObject>,
): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_METADATA_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Metadata exceeds ${MAX_METADATA_BYTES} UTF-8 bytes`,
    });
    return;
  }
  validateJsonValueBounds(value, 1, context);
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.json();
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);
export const BoundedJsonObjectSchema: z.ZodType<JsonObject> = z
  .record(z.string().max(200), JsonValueSchema)
  .superRefine(validateJsonObjectBounds);

export class AgentId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): AgentId {
    const value: string = AgentIdValueSchema.parse(input);
    return new AgentId(value);
  }

  public equals(other: AgentId): boolean {
    return this.value === other.value;
  }
}

export class DisplayName {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): DisplayName {
    const value: string = DisplayNameValueSchema.parse(input);
    return new DisplayName(value);
  }
}

export class MessageContent {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): MessageContent {
    const value: string = MessageContentValueSchema.parse(input);
    return new MessageContent(value);
  }
}

export class MessageId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): MessageId {
    const value: string = MessageIdValueSchema.parse(input);
    return new MessageId(value);
  }

  public static generate(): MessageId {
    return MessageId.parse(randomUUID());
  }

  public equals(other: MessageId): boolean {
    return this.value === other.value;
  }
}

export class BroadcastId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): BroadcastId {
    const value: string = BroadcastIdValueSchema.parse(input);
    return new BroadcastId(value);
  }

  public static generate(): BroadcastId {
    return BroadcastId.parse(randomUUID());
  }
}

export class ThreadId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): ThreadId {
    const value: string = ThreadIdValueSchema.parse(input);
    return new ThreadId(value);
  }

  public static generate(): ThreadId {
    return ThreadId.parse(randomUUID());
  }
}

export class IdempotencyKey {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): IdempotencyKey {
    const value: string = IdempotencyKeyValueSchema.parse(input);
    return new IdempotencyKey(value);
  }
}

export class RepositoryName {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): RepositoryName {
    const value: string = RepositoryNameValueSchema.parse(input);
    return new RepositoryName(value);
  }

  public equals(other: RepositoryName): boolean {
    return this.value === other.value;
  }
}

export class BranchName {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): BranchName {
    const value: string = BranchNameValueSchema.parse(input);
    return new BranchName(value);
  }

  public equals(other: BranchName): boolean {
    return this.value === other.value;
  }
}

export class AgentClient {
  public readonly value: "claude" | "codex";

  private constructor(value: "claude" | "codex") {
    this.value = value;
  }

  public static parse(input: unknown): AgentClient {
    const value: "claude" | "codex" = AgentClientValueSchema.parse(input);
    return new AgentClient(value);
  }

  public equals(other: AgentClient): boolean {
    return this.value === other.value;
  }
}

export class MachineName {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): MachineName {
    const value: string = MachineNameValueSchema.parse(input);
    return new MachineName(value);
  }
}

export class Sequence {
  public readonly value: number;

  private constructor(value: number) {
    this.value = value;
  }

  public static parse(input: unknown): Sequence {
    const value: number = SequenceValueSchema.parse(input);
    return new Sequence(value);
  }

  public static zero(): Sequence {
    return Sequence.parse(0);
  }

  public isAfter(other: Sequence): boolean {
    return this.value > other.value;
  }
}

export class TenantId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): TenantId {
    const value: string = TenantIdValueSchema.parse(input);
    return new TenantId(value);
  }

  public static founding(): TenantId {
    return TenantId.parse(FOUNDING_TENANT_ID);
  }

  public static generate(): TenantId {
    return TenantId.parse(randomUUID());
  }

  public equals(other: TenantId): boolean {
    return this.value === other.value;
  }
}

export class Instant {
  private readonly date: Date;

  private constructor(date: Date) {
    this.date = new Date(date.getTime());
  }

  public static parse(input: unknown): Instant {
    const value: string = InstantValueSchema.parse(input);
    return new Instant(new Date(value));
  }

  public static fromDate(date: Date): Instant {
    return Instant.parse(date.toISOString());
  }

  public addDays(days: number): Instant {
    const millisecondsPerDay: number = 24 * 60 * 60 * 1000;
    return Instant.fromDate(new Date(this.date.getTime() + days * millisecondsPerDay));
  }

  public addHours(hours: number): Instant {
    return Instant.fromDate(new Date(this.date.getTime() + hours * 60 * 60 * 1000));
  }

  public addMinutes(minutes: number): Instant {
    return Instant.fromDate(new Date(this.date.getTime() + minutes * 60 * 1000));
  }

  public isAfter(other: Instant): boolean {
    return this.date.getTime() > other.date.getTime();
  }

  public toISOString(): string {
    return this.date.toISOString();
  }

  public toEpochMilliseconds(): number {
    return this.date.getTime();
  }
}

export interface Clock {
  now(): Instant;
}

export class SystemClock implements Clock {
  public now(): Instant {
    return Instant.fromDate(new Date());
  }
}
