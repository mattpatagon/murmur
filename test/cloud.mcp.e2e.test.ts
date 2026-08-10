import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceUpdatedNotification } from "@modelcontextprotocol/sdk/types.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import postgres, { type Sql, type TransactionSql } from "postgres";

import {
  type BroadcastMessageOutput,
  BroadcastMessageOutputSchema,
  type InboxOutput,
  InboxOutputSchema,
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
  type WaitForMessagesOutput,
  WaitForMessagesOutputSchema,
} from "../src/domain/contracts.js";
import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import { postgresSslOptions, postgresTlsConfiguration } from "../src/postgres-tls.js";
import { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "../src/storage/postgres-message-store.js";
import {
  branchName,
  type ClientHarness,
  callValidated,
  clientName,
  cloudDatabaseUrl,
  connectClient,
  type DeferredSignal,
  deferredSignal,
  installMurmur,
  notificationTimeout,
  packMurmur,
  repositoryName,
  waitForMessageCommitLockWaiters,
} from "./support/cloud-mcp-harness.js";

test.skipIf(cloudDatabaseUrl === undefined)(
  "agents installed in isolated machine roots communicate through one Postgres URL",
  async (): Promise<void> => {
    const databaseUrl: string | undefined = cloudDatabaseUrl;
    if (databaseUrl === undefined) throw new Error("MURMUR_TEST_DATABASE_URL is required");
    const uniqueSuffix: string = randomUUID().replaceAll("-", "").slice(0, 12);
    const senderId: string = `cloud-sender-${uniqueSuffix}`;
    const receiverId: string = `cloud-receiver-${uniqueSuffix}`;
    const machineName: string = `cloud-machine-${uniqueSuffix}`;
    const portabilityRoot: string = mkdtempSync(join(tmpdir(), "murmur-portability-"));
    try {
      const packageArchive: string = packMurmur(join(portabilityRoot, "package"));
      const senderMachineRoot: string = join(portabilityRoot, "laptop-a", "bun-home");
      const receiverMachineRoot: string = join(portabilityRoot, "vm-b", "bun-home");
      const senderBinaryDirectory: string = installMurmur(packageArchive, senderMachineRoot);
      const receiverBinaryDirectory: string = installMurmur(packageArchive, receiverMachineRoot);
      const senderWorkspace: string = join(portabilityRoot, "laptop-a", "workspace one");
      const receiverWorkspace: string = join(portabilityRoot, "vm-b", "different-worktree");
      mkdirSync(senderWorkspace, { recursive: true });
      mkdirSync(receiverWorkspace, { recursive: true });

      const sender: ClientHarness = await connectClient(
        "claude-like-host",
        databaseUrl,
        senderBinaryDirectory,
        senderWorkspace,
      );
      try {
        const receiver: ClientHarness = await connectClient(
          "codex-like-host",
          databaseUrl,
          receiverBinaryDirectory,
          receiverWorkspace,
        );
        try {
          const senderRegistration: RegisterAgentOutput = await callValidated(
            sender.client,
            "register_agent",
            {
              agent_id: senderId,
              display_name: "Portable Sender",
              metadata: { machine: machineName },
            },
            RegisterAgentOutputSchema,
          );
          const receiverRegistration: RegisterAgentOutput = await callValidated(
            receiver.client,
            "register_agent",
            {
              agent_id: receiverId,
              display_name: "Portable Receiver",
              metadata: { machine: machineName },
            },
            RegisterAgentOutputSchema,
          );
          expect(senderRegistration.agent.agent_id).toBe(senderId);
          expect(receiverRegistration.agent.agent_id).toBe(receiverId);

          const senderPeers: ListAgentsOutput = await callValidated(
            sender.client,
            "list_agents",
            {},
            ListAgentsOutputSchema,
          );
          const receiverPeers: ListAgentsOutput = await callValidated(
            receiver.client,
            "list_agents",
            {},
            ListAgentsOutputSchema,
          );
          expect(
            senderPeers.agents.some(
              (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === receiverId,
            ),
          ).toBe(true);
          expect(
            receiverPeers.agents.some(
              (agent: ListAgentsOutput["agents"][number]): boolean => agent.agent_id === senderId,
            ),
          ).toBe(true);

          const receiverInboxUri: string = `murmur://inbox/${receiverId}`;
          let resolveNotification: ((value: ResourceUpdatedNotification) => void) | null = null;
          const notificationPromise: Promise<ResourceUpdatedNotification> = new Promise(
            (resolvePromise: (value: ResourceUpdatedNotification) => void): void => {
              resolveNotification = resolvePromise;
            },
          );
          receiver.client.setNotificationHandler(
            ResourceUpdatedNotificationSchema,
            (notification: ResourceUpdatedNotification): void => {
              const resolver: ((value: ResourceUpdatedNotification) => void) | null =
                resolveNotification;
              if (resolver === null) throw new Error("Cloud push resolver was not initialized");
              resolver(notification);
            },
          );
          await receiver.client.subscribeResource({ uri: receiverInboxUri });

          const sent: SendMessageOutput = await callValidated(
            sender.client,
            "send_message",
            {
              content: "hello from another installed machine root",
              idempotency_key: `cloud-e2e-forward-${uniqueSuffix}`,
              recipient_id: receiverId,
              sender_id: senderId,
            },
            SendMessageOutputSchema,
          );
          const pushed: ResourceUpdatedNotification = await Promise.race([
            notificationPromise,
            notificationTimeout(),
          ]);
          expect(pushed.params.uri).toBe(receiverInboxUri);
          expect(sent.message.context.repository).toBe(repositoryName);
          expect(sent.message.context.branch).toBe(branchName);
          expect(sent.message.context.client).toBe(clientName);
          expect(Number.isNaN(Date.parse(sent.message.created_at))).toBe(false);

          const receiverInbox: InboxOutput = await callValidated(
            receiver.client,
            "get_messages",
            {
              after_sequence: 0,
              agent_id: receiverId,
              limit: 100,
              unread_only: false,
            },
            InboxOutputSchema,
          );
          const receivedMessage: InboxOutput["messages"][number] | undefined =
            receiverInbox.messages.find(
              (message: InboxOutput["messages"][number]): boolean =>
                message.message_id === sent.message.message_id,
            );
          if (receivedMessage === undefined) throw new Error("Expected the cloud inbox message");
          expect(receivedMessage.context.repository).toBe(repositoryName);
          expect(receivedMessage.context.branch).toBe(branchName);
          expect(receivedMessage.context.client).toBe(clientName);
          expect(receivedMessage.created_at).toBe(sent.message.created_at);

          const broadcastNotification: Promise<ResourceUpdatedNotification> = new Promise(
            (resolvePromise: (value: ResourceUpdatedNotification) => void): void => {
              receiver.client.setNotificationHandler(
                ResourceUpdatedNotificationSchema,
                resolvePromise,
              );
            },
          );
          const broadcastArguments: Record<string, unknown> = {
            audience: { machine: machineName, repository: repositoryName },
            content: "broadcast through shared Postgres",
            idempotency_key: `cloud-e2e-broadcast-${uniqueSuffix}`,
            sender_id: senderId,
          };
          const broadcast: BroadcastMessageOutput = await callValidated(
            sender.client,
            "broadcast_message",
            broadcastArguments,
            BroadcastMessageOutputSchema,
          );
          expect(broadcast.recipient_count).toBe(1);
          const broadcastPush: ResourceUpdatedNotification = await Promise.race([
            broadcastNotification,
            notificationTimeout(),
          ]);
          expect(broadcastPush.params.uri).toBe(receiverInboxUri);
          const broadcastRetry: BroadcastMessageOutput = await callValidated(
            sender.client,
            "broadcast_message",
            broadcastArguments,
            BroadcastMessageOutputSchema,
          );
          expect(broadcastRetry.duplicate).toBe(true);
          expect(broadcastRetry.broadcast_id).toBe(broadcast.broadcast_id);
          expect(broadcastRetry.recipient_count).toBe(1);
          const inboxWithBroadcast: InboxOutput = await callValidated(
            receiver.client,
            "get_messages",
            {
              after_sequence: sent.message.sequence,
              agent_id: receiverId,
              limit: 100,
              unread_only: false,
            },
            InboxOutputSchema,
          );
          const receivedBroadcast: InboxOutput["messages"][number] | undefined =
            inboxWithBroadcast.messages.find(
              (message: InboxOutput["messages"][number]): boolean =>
                message.thread_id === broadcast.thread_id,
            );
          if (receivedBroadcast === undefined) {
            throw new Error("Expected the cloud broadcast message");
          }
          expect(receivedBroadcast.content).toBe("broadcast through shared Postgres");
          expect(Object.hasOwn(receivedBroadcast, "broadcast_id")).toBe(false);

          const coordinationDatabase: Sql = postgres(databaseUrl, {
            connect_timeout: 10,
            max: 2,
            ssl: postgresSslOptions(databaseUrl, postgresTlsConfiguration(process.env)),
          });
          const tenantReceiverId: string = `${FOUNDING_TENANT_ID}:${receiverId}`;
          const lockHeld: DeferredSignal = deferredSignal();
          const commitLockReleased: DeferredSignal = deferredSignal();
          const lockHolder: Promise<unknown> = coordinationDatabase.begin(
            async (transaction: TransactionSql): Promise<void> => {
              await transaction`
                SELECT pg_catalog.pg_advisory_xact_lock(
                  pg_catalog.hashtextextended(
                    ${tenantReceiverId},
                    ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
                  )
                )
              `;
              lockHeld.resolve();
              await commitLockReleased.promise;
            },
          );
          try {
            await lockHeld.promise;
            let orderedNotificationCount: number = 0;
            const orderedNotifications: DeferredSignal = deferredSignal();
            receiver.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (): void => {
              orderedNotificationCount += 1;
              if (orderedNotificationCount === 2) orderedNotifications.resolve();
            });
            const orderedBroadcastPromise: Promise<BroadcastMessageOutput> = callValidated(
              sender.client,
              "broadcast_message",
              {
                audience: {
                  machine: machineName,
                  repository: repositoryName,
                },
                content: "ordered broadcast",
                idempotency_key: `cloud-e2e-ordered-broadcast-${uniqueSuffix}`,
                sender_id: senderId,
              },
              BroadcastMessageOutputSchema,
            );
            await waitForMessageCommitLockWaiters(coordinationDatabase, receiverId, 1);
            const orderedDirectPromise: Promise<SendMessageOutput> = callValidated(
              sender.client,
              "send_message",
              {
                content: "ordered direct message",
                idempotency_key: `cloud-e2e-ordered-direct-${uniqueSuffix}`,
                recipient_id: receiverId,
                sender_id: senderId,
              },
              SendMessageOutputSchema,
            );
            await waitForMessageCommitLockWaiters(coordinationDatabase, receiverId, 2);
            commitLockReleased.resolve();
            const [orderedBroadcast, orderedDirect]: [BroadcastMessageOutput, SendMessageOutput] =
              await Promise.all([orderedBroadcastPromise, orderedDirectPromise]);
            expect(orderedBroadcast.recipient_count).toBe(1);
            await Promise.race([orderedNotifications.promise, notificationTimeout()]);
            const orderedInbox: InboxOutput = await callValidated(
              receiver.client,
              "get_messages",
              {
                after_sequence: receivedBroadcast.sequence,
                agent_id: receiverId,
                limit: 100,
                unread_only: false,
              },
              InboxOutputSchema,
            );
            expect(
              orderedInbox.messages.map(
                (message: InboxOutput["messages"][number]): string => message.content,
              ),
            ).toEqual(["ordered broadcast", "ordered direct message"]);
            const lastOrderedMessage: InboxOutput["messages"][number] | undefined =
              orderedInbox.messages.at(-1);
            if (lastOrderedMessage === undefined) throw new Error("Expected ordered messages");
            expect(lastOrderedMessage.message_id).toBe(orderedDirect.message.message_id);
          } finally {
            commitLockReleased.resolve();
            await Promise.allSettled([lockHolder]);
            await coordinationDatabase.end({ timeout: 1 });
          }

          const waitForReply: Promise<WaitForMessagesOutput> = callValidated(
            sender.client,
            "wait_for_messages",
            { after_sequence: 0, agent_id: senderId, timeout_seconds: 12 },
            WaitForMessagesOutputSchema,
          );
          const reply: SendMessageOutput = await callValidated(
            receiver.client,
            "send_message",
            {
              content: "reply from the other workspace",
              idempotency_key: `cloud-e2e-reply-${uniqueSuffix}`,
              recipient_id: senderId,
              sender_id: receiverId,
              thread_id: sent.message.thread_id,
            },
            SendMessageOutputSchema,
          );
          const waited: WaitForMessagesOutput = await waitForReply;
          expect(reply.message.context.repository).toBe(repositoryName);
          expect(reply.message.context.branch).toBe(branchName);
          expect(reply.message.context.client).toBe(clientName);
          expect(waited.timed_out).toBe(false);
          const waitedMessage: WaitForMessagesOutput["messages"][number] | undefined =
            waited.messages.find(
              (message: WaitForMessagesOutput["messages"][number]): boolean =>
                message.message_id === reply.message.message_id,
            );
          if (waitedMessage === undefined) throw new Error("Expected the cloud reply message");
          expect(waitedMessage.context.repository).toBe(repositoryName);
          expect(waitedMessage.context.branch).toBe(branchName);
          expect(waitedMessage.context.client).toBe(clientName);
          expect(waitedMessage.created_at).toBe(reply.message.created_at);

          const receiverMarked: MarkMessagesReadOutput = await callValidated(
            receiver.client,
            "mark_messages_read",
            {
              agent_id: receiverId,
              message_ids: [sent.message.message_id, receivedBroadcast.message_id],
            },
            MarkMessagesReadOutputSchema,
          );
          const senderMarked: MarkMessagesReadOutput = await callValidated(
            sender.client,
            "mark_messages_read",
            { agent_id: senderId, message_ids: [reply.message.message_id] },
            MarkMessagesReadOutputSchema,
          );
          expect(receiverMarked.updated).toBe(2);
          expect(senderMarked.updated).toBe(1);
          expect(sent.message.expires_at).toBeDefined();
        } finally {
          await Promise.allSettled([receiver.client.close()]);
        }
      } finally {
        await Promise.allSettled([sender.client.close()]);
      }
    } finally {
      rmSync(portabilityRoot, { force: true, recursive: true });
    }
  },
  60_000,
);
