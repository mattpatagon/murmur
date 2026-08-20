import {
  agentClientFromInput,
  branchNameFromInput,
  type MessageContextDto,
  repositoryNameFromInput,
  toAgentDto,
  toMessageDto,
} from "../domain/contracts.js";
import { AgentAuthorityConflictError } from "../domain/errors.js";
import type { Agent, Message } from "../domain/models.js";
import type { SenderAuthority } from "../domain/orchestration.js";
import type { AgentClient, AgentId, BranchName, RepositoryName } from "../domain/value-objects.js";
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

export type RequiredDataContext = {
  readonly branchName: BranchName;
  readonly client: AgentClient;
  readonly repositoryName: RepositoryName;
};

export function requiredDataContext(
  input: MessageContextDto | undefined,
  fallback: {
    readonly branchName: BranchName | null;
    readonly client: AgentClient | null;
    readonly repositoryName: RepositoryName | null;
  },
  subject: "Feedback" | "Message",
): RequiredDataContext {
  const repositoryName: RepositoryName | null = repositoryNameFromInput(
    input,
    fallback.repositoryName,
  );
  if (repositoryName === null) {
    throw new Error(
      `${subject} repository context is required. Supply context.repository or configure MURMUR_REPOSITORY/X-Murmur-Repository.`,
    );
  }
  const branchName: BranchName | null = branchNameFromInput(input, fallback.branchName);
  if (branchName === null) {
    throw new Error(
      `${subject} branch context is required. Supply context.branch or configure MURMUR_BRANCH/X-Murmur-Branch.`,
    );
  }
  const client: AgentClient | null = agentClientFromInput(input, fallback.client);
  if (client === null) {
    throw new Error(
      `${subject} client context is required. Supply context.client or configure MURMUR_CLIENT/X-Murmur-Client.`,
    );
  }
  return { branchName, client, repositoryName };
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
