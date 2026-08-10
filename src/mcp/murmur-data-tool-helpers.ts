import { AgentAuthorityConflictError } from "../domain/errors.js";
import type { Agent, Message } from "../domain/models.js";
import type { SenderAuthority } from "../domain/orchestration.js";
import { toAgentDto, toMessageDto } from "../domain/contracts.js";
import type { AgentId } from "../domain/value-objects.js";
import type { MessageStore } from "../storage/message-store.js";

export async function authorizedActorId(
  agentId: AgentId,
  senderAuthority: SenderAuthority,
  store: MessageStore,
): Promise<AgentId> {
  const agent: Agent | null = await store.getAgent(agentId);
  if (agent !== null && agent.authority !== senderAuthority) {
    throw new AgentAuthorityConflictError();
  }
  return agentId;
}

export function agentDtoForClient(
  agent: Agent,
  legacyMessageShape: boolean,
): Record<string, unknown> {
  const dto: ReturnType<typeof toAgentDto> = toAgentDto(agent);
  if (!legacyMessageShape) return { ...dto };
  return {
    agent_id: dto.agent_id,
    closed_at: dto.closed_at,
    close_reason: dto.close_reason,
    created_at: dto.created_at,
    display_name: dto.display_name,
    generation: dto.generation,
    last_seen_at: dto.last_seen_at,
    lease_expires_at: dto.lease_expires_at,
    live_session_count: dto.live_session_count,
    metadata: dto.metadata,
    state: dto.state,
  };
}

export function messageDtoForClient(
  message: Message,
  legacyMessageShape: boolean,
): Record<string, unknown> {
  const dto: ReturnType<typeof toMessageDto> = toMessageDto(message);
  if (!legacyMessageShape) return { ...dto };
  return {
    content: dto.content,
    context: dto.context,
    created_at: dto.created_at,
    expires_at: dto.expires_at,
    message_id: dto.message_id,
    read_at: dto.read_at,
    recipient_id: dto.recipient_id,
    sender_id: dto.sender_id,
    sequence: dto.sequence,
    thread_id: dto.thread_id,
  };
}
