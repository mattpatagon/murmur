import type { MurmurClient } from "./setup/user-configuration.js";

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
  readonly agentGeneration: number;
  readonly inboxVersion: number;
  readonly messageCount: number;
  readonly noticeCount?: number | undefined;
  readonly senderIds: readonly string[];
};

export type JsonRpcExchange = { readonly body: unknown; readonly response: Response };
