import { z } from "zod";

import {
  AgentCloseReasonSchema,
  AgentGeneration,
  AgentListStateSchema,
  AgentStateSchema,
  ExplicitAgentCloseReasonSchema,
  SessionEndReasonSchema,
  SessionKeyInputSchema,
  SessionKey,
} from "./lifecycle-values.js";
import type {
  Agent,
  CloseAgentCommand,
  EndSessionCommand,
  ListAgentsQuery,
  ListAgentsResult,
  RegisterAgentCommand,
} from "./models.js";
import {
  AgentId,
  BoundedJsonObjectSchema,
  DisplayName,
  type JsonObject,
  JsonObjectSchema,
} from "./value-objects.js";

const AgentIdTextSchema: z.ZodString = z.string().min(1).max(200);
const DisplayNameTextSchema: z.ZodString = z.string().min(1).max(200);
const InstantTextSchema: z.ZodISODateTime = z.iso.datetime({ offset: true });
const GenerationNumberSchema: z.ZodNumber = z.number().int().positive().safe();

export type AgentDto = {
  readonly agent_id: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
  readonly created_at: string;
  readonly display_name: string;
  readonly generation: number;
  readonly last_seen_at: string;
  readonly lease_expires_at: string | null;
  readonly live_session_count: number;
  readonly metadata: JsonObject;
  readonly state: "active" | "inactive" | "closed";
};

export const AgentDtoSchema: z.ZodType<AgentDto> = z.strictObject({
  agent_id: AgentIdTextSchema,
  closed_at: InstantTextSchema.nullable(),
  close_reason: AgentCloseReasonSchema.nullable(),
  created_at: InstantTextSchema,
  display_name: DisplayNameTextSchema,
  generation: GenerationNumberSchema,
  last_seen_at: InstantTextSchema,
  lease_expires_at: InstantTextSchema.nullable(),
  live_session_count: z.number().int().nonnegative(),
  metadata: JsonObjectSchema,
  state: AgentStateSchema,
});

export function toAgentDto(agent: Agent): AgentDto {
  return {
    agent_id: agent.agentId.value,
    closed_at: agent.closedAt === null ? null : agent.closedAt.toISOString(),
    close_reason: agent.closeReason,
    created_at: agent.createdAt.toISOString(),
    display_name: agent.displayName.value,
    generation: agent.generation.value,
    last_seen_at: agent.lastSeenAt.toISOString(),
    lease_expires_at: agent.leaseExpiresAt === null ? null : agent.leaseExpiresAt.toISOString(),
    live_session_count: agent.liveSessionCount,
    metadata: agent.metadata,
    state: agent.state,
  };
}

export type RegisterAgentInput = {
  readonly agent_id: string;
  readonly display_name?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly session_key?: string | undefined;
};

export const RegisterAgentInputSchema: z.ZodType<RegisterAgentInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  display_name: DisplayNameTextSchema.optional(),
  metadata: BoundedJsonObjectSchema.optional(),
  session_key: SessionKeyInputSchema.optional(),
});

export function registerAgentCommand(input: RegisterAgentInput): RegisterAgentCommand {
  const displayNameText: string =
    input.display_name === undefined ? input.agent_id : input.display_name;
  return {
    agentId: AgentId.parse(input.agent_id),
    displayName: DisplayName.parse(displayNameText),
    metadata: input.metadata === undefined ? {} : input.metadata,
    sessionKey:
      input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key),
  };
}

export type GetAgentInput = { readonly agent_id: string };
export const GetAgentInputSchema: z.ZodType<GetAgentInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
});

export type GetAgentOutput = Record<string, unknown> & { readonly agent: AgentDto };
export const GetAgentOutputSchema: z.ZodType<GetAgentOutput> = z.strictObject({
  agent: AgentDtoSchema,
});

export type ListAgentsInput = {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly state: "active" | "all" | "closed" | "inactive" | "open";
};

export const ListAgentsInputSchema: z.ZodType<ListAgentsInput> = z.strictObject({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(1_000).default(1_000),
  state: AgentListStateSchema.default("active"),
});

function decodeAgentCursor(value: string): AgentId {
  try {
    const decoded: string = Buffer.from(value, "base64url").toString("utf8");
    return AgentId.parse(z.tuple([AgentIdTextSchema]).parse(JSON.parse(decoded))[0]);
  } catch (_error: unknown) {
    throw new Error("Invalid agent cursor");
  }
}

export function encodeAgentCursor(agentId: AgentId): string {
  return Buffer.from(JSON.stringify([agentId.value]), "utf8").toString("base64url");
}

export function listAgentsQuery(input: ListAgentsInput): ListAgentsQuery {
  return {
    cursor: input.cursor === undefined ? null : decodeAgentCursor(input.cursor),
    limit: input.limit,
    state: AgentListStateSchema.parse(input.state),
  };
}

export type RegisterAgentOutput = Record<string, unknown> & {
  readonly agent: AgentDto;
  readonly inbox_uri: string;
  readonly lease_minutes: number;
  readonly reopened: boolean;
  readonly repository_diverged: boolean;
  readonly retention_days: number;
};

export const RegisterAgentOutputSchema: z.ZodType<RegisterAgentOutput> = z.strictObject({
  agent: AgentDtoSchema,
  inbox_uri: z.string().url(),
  lease_minutes: z.number().int().positive(),
  reopened: z.boolean(),
  repository_diverged: z.boolean(),
  retention_days: z.number().int().positive(),
});

export type ListAgentsOutput = Record<string, unknown> & {
  readonly agents: AgentDto[];
  readonly next_cursor: string | null;
};
export const ListAgentsOutputSchema: z.ZodType<ListAgentsOutput> = z.strictObject({
  agents: z.array(AgentDtoSchema),
  next_cursor: z.string().min(1).max(500).nullable(),
});

export function toListAgentsOutput(result: ListAgentsResult): ListAgentsOutput {
  return {
    agents: result.agents.map(toAgentDto),
    next_cursor: result.nextCursor === null ? null : encodeAgentCursor(result.nextCursor),
  };
}

export type EndSessionInput = {
  readonly agent_id: string;
  readonly end_default_session: boolean;
  readonly expected_generation: number;
  readonly reason: "session_end" | "stop";
  readonly session_key?: string | undefined;
};

export const EndSessionInputSchema: z.ZodType<EndSessionInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  end_default_session: z.boolean().default(false),
  expected_generation: GenerationNumberSchema,
  reason: z.enum(["stop", "session_end"]).default("stop"),
  session_key: SessionKeyInputSchema.optional(),
});

export function endSessionCommand(input: EndSessionInput): EndSessionCommand {
  return {
    agentId: AgentId.parse(input.agent_id),
    endDefaultSession: input.end_default_session,
    endReason: SessionEndReasonSchema.parse(input.reason),
    expectedGeneration: AgentGeneration.parse(input.expected_generation),
    sessionKey:
      input.session_key === undefined ? SessionKey.default() : SessionKey.parse(input.session_key),
  };
}

export type EndSessionOutput = Record<string, unknown> & {
  readonly ended: number;
  readonly generation: number | null;
};

export const EndSessionOutputSchema: z.ZodType<EndSessionOutput> = z.strictObject({
  ended: z.number().int().nonnegative(),
  generation: GenerationNumberSchema.nullable(),
});

export type CloseAgentInput = {
  readonly agent_id: string;
  readonly expected_generation: number;
  readonly reason: "completed" | "manual" | "superseded" | "workspace_deleted";
};

export const CloseAgentInputSchema: z.ZodType<CloseAgentInput> = z.strictObject({
  agent_id: AgentIdTextSchema,
  expected_generation: GenerationNumberSchema,
  reason: ExplicitAgentCloseReasonSchema,
});

export function closeAgentCommand(input: CloseAgentInput): CloseAgentCommand {
  return {
    agentId: AgentId.parse(input.agent_id),
    closeReason: ExplicitAgentCloseReasonSchema.parse(input.reason),
    expectedGeneration: AgentGeneration.parse(input.expected_generation),
  };
}

export type CloseAgentOutput = Record<string, unknown> & {
  readonly agent: AgentDto;
  readonly already_closed: boolean;
  readonly ended_sessions: number;
  readonly unread_count: number;
};

export const CloseAgentOutputSchema: z.ZodType<CloseAgentOutput> = z.strictObject({
  agent: AgentDtoSchema,
  already_closed: z.boolean(),
  ended_sessions: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
});
