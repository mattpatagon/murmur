import { randomUUID } from "node:crypto";

import { z } from "zod";

const GenerationValueSchema: z.ZodNumber = z.number().int().positive().safe();
const SessionKeyValueSchema: z.ZodString = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const NoticeIdValueSchema: z.ZodString = z.string().uuid();
const NoticeContentValueSchema: z.ZodString = z.string().min(1).max(100_000);
const ResolutionNoteValueSchema: z.ZodString = z.string().trim().min(1).max(2_000);

export const AGENT_LEASE_MINUTES: number = 60;
export const AGENT_DORMANCY_DAYS: number = 30;
export const AGENT_GC_DAYS: number = 30;
export const MAX_OPEN_AGENTS: number = 1_000;
export const MAX_LIVE_SESSIONS_PER_AGENT: number = 8;
export const MAX_RETAINED_SESSIONS_PER_AGENT: number = 64;
export const DEFAULT_SESSION_KEY: string = "default";
export const NOTICE_DEFAULT_TTL_HOURS: number = 14 * 24;
export const NOTICE_MIN_TTL_HOURS: number = 1;
export const NOTICE_MAX_TTL_HOURS: number = 90 * 24;
export const NOTICE_AUDIT_DAYS: number = 30;
export const MAX_RETAINED_NOTICES: number = 10_000;
export const MAX_NOTICE_CONTENT_BYTES: number = 64 * 1024 * 1024;

export const AgentStateSchema: z.ZodEnum<{
  active: "active";
  closed: "closed";
  inactive: "inactive";
}> = z.enum(["active", "inactive", "closed"]);
export type AgentState = z.infer<typeof AgentStateSchema>;

export const AgentListStateSchema: z.ZodEnum<{
  active: "active";
  all: "all";
  closed: "closed";
  inactive: "inactive";
  open: "open";
}> = z.enum(["active", "open", "inactive", "closed", "all"]);
export type AgentListState = z.infer<typeof AgentListStateSchema>;

export const AgentCloseReasonSchema: z.ZodEnum<{
  completed: "completed";
  dormant: "dormant";
  manual: "manual";
  superseded: "superseded";
  workspace_deleted: "workspace_deleted";
}> = z.enum(["completed", "workspace_deleted", "superseded", "manual", "dormant"]);
export type AgentCloseReason = z.infer<typeof AgentCloseReasonSchema>;

export const ExplicitAgentCloseReasonSchema: z.ZodEnum<{
  completed: "completed";
  manual: "manual";
  superseded: "superseded";
  workspace_deleted: "workspace_deleted";
}> = z.enum(["completed", "workspace_deleted", "superseded", "manual"]);
export type ExplicitAgentCloseReason = z.infer<typeof ExplicitAgentCloseReasonSchema>;

export const SessionEndReasonSchema: z.ZodEnum<{
  closed: "closed";
  expired: "expired";
  session_end: "session_end";
  stop: "stop";
  superseded: "superseded";
}> = z.enum(["stop", "session_end", "superseded", "expired", "closed"]);
export type SessionEndReason = z.infer<typeof SessionEndReasonSchema>;

export const NoticeKindSchema: z.ZodEnum<{
  blocker: "blocker";
  decision: "decision";
  handoff: "handoff";
  ownership: "ownership";
}> = z.enum(["handoff", "ownership", "blocker", "decision"]);
export type NoticeKind = z.infer<typeof NoticeKindSchema>;

export const NoticeStateSchema: z.ZodEnum<{
  expired: "expired";
  open: "open";
  resolved: "resolved";
  withdrawn: "withdrawn";
}> = z.enum(["open", "resolved", "withdrawn", "expired"]);
export type NoticeState = z.infer<typeof NoticeStateSchema>;

export class AgentGeneration {
  public readonly value: number;

  private constructor(value: number) {
    this.value = value;
  }

  public static parse(input: unknown): AgentGeneration {
    return new AgentGeneration(GenerationValueSchema.parse(input));
  }

  public next(): AgentGeneration {
    return AgentGeneration.parse(this.value + 1);
  }

  public equals(other: AgentGeneration): boolean {
    return this.value === other.value;
  }
}

export class SessionKey {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): SessionKey {
    return new SessionKey(SessionKeyValueSchema.parse(input));
  }

  public static default(): SessionKey {
    return SessionKey.parse(DEFAULT_SESSION_KEY);
  }

  public isDefault(): boolean {
    return this.value === DEFAULT_SESSION_KEY;
  }
}

export class NoticeId {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): NoticeId {
    return new NoticeId(NoticeIdValueSchema.parse(input));
  }

  public static generate(): NoticeId {
    return NoticeId.parse(randomUUID());
  }
}

export class NoticeContent {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): NoticeContent {
    return new NoticeContent(NoticeContentValueSchema.parse(input));
  }
}

export class ResolutionNote {
  public readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  public static parse(input: unknown): ResolutionNote {
    return new ResolutionNote(ResolutionNoteValueSchema.parse(input));
  }
}
