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
  "macOS and Linux MCP processes communicate through one Postgres URL",
  async (): Promise<void> => {
    const databaseUrl: string | undefined = cloudDatabaseUrl;
    const imageName: string | undefined = dockerImage;
    if (databaseUrl === undefined) throw new Error("MURMUR_TEST_DATABASE_URL is required");
    if (imageName === undefined) throw new Error("MURMUR_TEST_DOCKER_IMAGE is required");
    const uniqueSuffix: string = randomUUID().replaceAll("-", "").slice(0, 12);
    const macAgentId: string = `mac-agent-${uniqueSuffix}`;
    const linuxAgentId: string = `linux-agent-${uniqueSuffix}`;
    const macClient: ClientHarness = await connectProjectClient("macos-host", databaseUrl);
    try {
      const linuxClient: ClientHarness = await connectDockerClient(
        "linux-vm-host",
        databaseUrl,
        imageName,
      );
      try {
        await callValidated(
          macClient.client,
          "register_agent",
          { agent_id: macAgentId, display_name: "macOS Agent" },
          RegisterAgentOutputSchema,
        );
        await callValidated(
          linuxClient.client,
          "register_agent",
          { agent_id: linuxAgentId, display_name: "Linux Agent" },
          RegisterAgentOutputSchema,
        );

        const macPeers: ListAgentsOutput = await callValidated(
          macClient.client,
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
          macPeers.agents.some(
            (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === linuxAgentId,
          ),
        ).toBe(true);
        expect(
          linuxPeers.agents.some(
            (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === macAgentId,
          ),
        ).toBe(true);

        const linuxWait: Promise<WaitForMessagesOutput> = callValidated(
          linuxClient.client,
          "wait_for_messages",
          { after_sequence: 0, agent_id: linuxAgentId, timeout_seconds: 12 },
          WaitForMessagesOutputSchema,
        );
        const sentToLinux: SendMessageOutput = await callValidated(
          macClient.client,
          "send_message",
          {
            content: "hello from macOS to Linux",
            idempotency_key: `mac-linux-${uniqueSuffix}`,
            recipient_id: linuxAgentId,
            sender_id: macAgentId,
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

        const macWait: Promise<WaitForMessagesOutput> = callValidated(
          macClient.client,
          "wait_for_messages",
          { after_sequence: 0, agent_id: macAgentId, timeout_seconds: 12 },
          WaitForMessagesOutputSchema,
        );
        const sentToMac: SendMessageOutput = await callValidated(
          linuxClient.client,
          "send_message",
          {
            content: "reply from Linux to macOS",
            idempotency_key: `linux-mac-${uniqueSuffix}`,
            recipient_id: macAgentId,
            sender_id: linuxAgentId,
            thread_id: sentToLinux.message.thread_id,
          },
          SendMessageOutputSchema,
        );
        const receivedOnMac: WaitForMessagesOutput = await macWait;
        expect(sentToMac.message.context.repository).toBe(repositoryName);
        expect(sentToMac.message.context.branch).toBe(branchName);
        expect(sentToMac.message.context.client).toBe(clientName);
        expect(receivedOnMac.timed_out).toBe(false);
        expect(
          receivedOnMac.messages.some(
            (message: WaitForMessagesOutput["messages"][number]): boolean =>
              message.message_id === sentToMac.message.message_id &&
              message.context.repository === repositoryName,
          ),
        ).toBe(true);
      } finally {
        await Promise.allSettled([linuxClient.client.close()]);
      }
    } finally {
      await Promise.allSettled([macClient.client.close()]);
    }
  },
  60_000,
);
