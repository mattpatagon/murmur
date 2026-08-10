import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import {
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
  type WaitForMessagesOutput,
  WaitForMessagesOutputSchema,
} from "../src/domain/contracts.js";
import {
  branchName,
  type ClientHarness,
  callValidated,
  clientName,
  cloudDatabaseUrl,
  connectDockerClient,
  connectProjectClient,
  dockerImage,
  repositoryName,
} from "./support/cloud-mcp-harness.js";

test.skipIf(cloudDatabaseUrl === undefined || dockerImage === undefined)(
  "host and Linux-container MCP processes communicate through one Postgres URL",
  async (): Promise<void> => {
    const databaseUrl: string | undefined = cloudDatabaseUrl;
    const imageName: string | undefined = dockerImage;
    if (databaseUrl === undefined) throw new Error("MURMUR_TEST_DATABASE_URL is required");
    if (imageName === undefined) throw new Error("MURMUR_TEST_DOCKER_IMAGE is required");
    const uniqueSuffix: string = randomUUID().replaceAll("-", "").slice(0, 12);
    const hostAgentId: string = `host-agent-${uniqueSuffix}`;
    const linuxAgentId: string = `linux-agent-${uniqueSuffix}`;
    const hostClient: ClientHarness = await connectProjectClient("host-process", databaseUrl);
    try {
      const linuxClient: ClientHarness = await connectDockerClient(
        "linux-vm-host",
        databaseUrl,
        imageName,
      );
      try {
        await callValidated(
          hostClient.client,
          "register_agent",
          { agent_id: hostAgentId, display_name: "Host Agent" },
          RegisterAgentOutputSchema,
        );
        await callValidated(
          linuxClient.client,
          "register_agent",
          { agent_id: linuxAgentId, display_name: "Linux Agent" },
          RegisterAgentOutputSchema,
        );

        const hostPeers: ListAgentsOutput = await callValidated(
          hostClient.client,
          "list_agents",
          {},
          ListAgentsOutputSchema,
        );
        const linuxPeers: ListAgentsOutput = await callValidated(
          linuxClient.client,
          "list_agents",
          {},
          ListAgentsOutputSchema,
        );
        expect(
          hostPeers.agents.some(
            (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === linuxAgentId,
          ),
        ).toBe(true);
        expect(
          linuxPeers.agents.some(
            (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === hostAgentId,
          ),
        ).toBe(true);

        const linuxWait: Promise<WaitForMessagesOutput> = callValidated(
          linuxClient.client,
          "wait_for_messages",
          { after_sequence: 0, agent_id: linuxAgentId, timeout_seconds: 12 },
          WaitForMessagesOutputSchema,
        );
        const sentToLinux: SendMessageOutput = await callValidated(
          hostClient.client,
          "send_message",
          {
            content: "hello from host to Linux container",
            idempotency_key: `host-linux-${uniqueSuffix}`,
            recipient_id: linuxAgentId,
            sender_id: hostAgentId,
          },
          SendMessageOutputSchema,
        );
        const receivedOnLinux: WaitForMessagesOutput = await linuxWait;
        expect(sentToLinux.message.context.repository).toBe(repositoryName);
        expect(sentToLinux.message.context.branch).toBe(branchName);
        expect(sentToLinux.message.context.client).toBe(clientName);
        expect(receivedOnLinux.timed_out).toBe(false);
        expect(
          receivedOnLinux.messages.some(
            (message: WaitForMessagesOutput["messages"][number]): boolean =>
              message.message_id === sentToLinux.message.message_id &&
              message.context.repository === repositoryName,
          ),
        ).toBe(true);

        const hostWait: Promise<WaitForMessagesOutput> = callValidated(
          hostClient.client,
          "wait_for_messages",
          { after_sequence: 0, agent_id: hostAgentId, timeout_seconds: 12 },
          WaitForMessagesOutputSchema,
        );
        const sentToHost: SendMessageOutput = await callValidated(
          linuxClient.client,
          "send_message",
          {
            content: "reply from Linux container to host",
            idempotency_key: `linux-host-${uniqueSuffix}`,
            recipient_id: hostAgentId,
            sender_id: linuxAgentId,
            thread_id: sentToLinux.message.thread_id,
          },
          SendMessageOutputSchema,
        );
        const receivedOnHost: WaitForMessagesOutput = await hostWait;
        expect(sentToHost.message.context.repository).toBe(repositoryName);
        expect(sentToHost.message.context.branch).toBe(branchName);
        expect(sentToHost.message.context.client).toBe(clientName);
        expect(receivedOnHost.timed_out).toBe(false);
        expect(
          receivedOnHost.messages.some(
            (message: WaitForMessagesOutput["messages"][number]): boolean =>
              message.message_id === sentToHost.message.message_id &&
              message.context.repository === repositoryName,
          ),
        ).toBe(true);
      } finally {
        await Promise.allSettled([linuxClient.client.close()]);
      }
    } finally {
      await Promise.allSettled([hostClient.client.close()]);
    }
  },
  60_000,
);
