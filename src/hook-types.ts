import type { MurmurClient } from "./setup/user-configuration.js";
import type { HookOrchestrationState } from "./hook-orchestration.js";

export type AgentIdentity = {
  readonly agentId: string;
  readonly branch: string | null;
  readonly client: MurmurClient;
  readonly displayName: string;
  readonly machine: string;
  readonly repository: string | null;
  readonly workspace: string;
  readonly workspaceHash: string;
};

export type InboxSummary = {
  readonly agentGeneration?: number | undefined;
  readonly inboxVersion: number;
  readonly messageCount: number;
  readonly noticeCount?: number | undefined;
  readonly orchestration?: HookOrchestrationState | undefined;
  readonly orchestratorMessageCount?: number | undefined;
  readonly senderIds: readonly string[];
};

export type JsonRpcExchange = { readonly body: unknown; readonly response: Response };
