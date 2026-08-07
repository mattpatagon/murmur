import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  ResourceUpdatedNotification,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { z } from "zod";

import {
  BroadcastMessageOutputSchema,
  InboxOutputSchema,
  ListAgentsOutputSchema,
  MarkMessagesReadOutputSchema,
  RegisterAgentOutputSchema,
  SendMessageOutputSchema,
  WaitForMessagesOutputSchema,
  type BroadcastMessageOutput,
  type InboxOutput,
  type ListAgentsOutput,
  type MarkMessagesReadOutput,
  type RegisterAgentOutput,
  type SendMessageOutput,
  type WaitForMessagesOutput,
} from "../src/domain/contracts.js";
import { POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED } from "../src/storage/postgres-message-store.js";

const cloudDatabaseUrl: string | undefined = process.env["MURMUR_TEST_DATABASE_URL"];
const dockerImage: string | undefined = process.env["MURMUR_TEST_DOCKER_IMAGE"];
const projectRoot: string = resolve(".");
const repositoryName: string = "mattpatagon/murmur";
const branchName: string = "feature/cloud-context";
const clientName: "codex" = "codex";

type ClientHarness = {
  readonly client: Client;
  readonly transport: StdioClientTransport;
};

type AdvisoryWaiterCountRow = {
  readonly count: number | string;
};

type DeferredSignal = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferredSignal(): DeferredSignal {
  let resolver: (() => void) | null = null;
  const promise: Promise<void> = new Promise((resolvePromise: () => void): void => {
    resolver = resolvePromise;
  });
  return {
    promise,
    resolve: (): void => {
      const currentResolver: (() => void) | null = resolver;
      if (currentResolver === null) throw new Error("Deferred signal was not initialized");
      currentResolver();
    },
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command '${command}' failed with status ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function packMurmur(packageDirectory: string): string {
  mkdirSync(packageDirectory, { recursive: true });
  runCommand(
    process.execPath,
    ["pm", "pack", "--destination", packageDirectory, "--ignore-scripts"],
    projectRoot,
  );
  const archives: string[] = readdirSync(packageDirectory).filter((fileName: string): boolean =>
    fileName.endsWith(".tgz"),
  );
  const archiveName: string | undefined = archives[0];
  if (archiveName === undefined) throw new Error("Murmur package archive was not created");
  return join(packageDirectory, archiveName);
}

function installMurmur(packageArchive: string, machineRoot: string): string {
  mkdirSync(machineRoot, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_INSTALL: machineRoot,
  };
  runCommand(process.execPath, ["install", "--global", packageArchive], machineRoot, environment);
  return join(machineRoot, "bin");
}

function cloudChildEnvironment(
  databaseUrl: string,
  binaryDirectory: string,
): Record<string, string> {
  const environment: Record<string, string> = hostChildEnvironment(databaseUrl);
  const hostPath: string = environment["PATH"] ?? "";
  environment["PATH"] =
    `${binaryDirectory}${delimiter}${dirname(process.execPath)}${delimiter}${hostPath}`;
  return environment;
}

function hostChildEnvironment(databaseUrl: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const hostPath: string | undefined = process.env["PATH"];
  if (hostPath === undefined) throw new Error("PATH is required for the portability test");
  environment["PATH"] = hostPath;
  environment["MURMUR_DATABASE_URL"] = databaseUrl;
  environment["MURMUR_BRANCH"] = branchName;
  environment["MURMUR_CLIENT"] = clientName;
  environment["MURMUR_REPOSITORY"] = repositoryName;
  return environment;
}

async function connectClient(
  name: string,
  databaseUrl: string,
  binaryDirectory: string,
  workspace: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [],
    command: "murmur-mcp",
    cwd: workspace,
    env: cloudChildEnvironment(databaseUrl, binaryDirectory),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function connectProjectClient(name: string, databaseUrl: string): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: ["run", "src/server.ts"],
    command: "bun",
    cwd: projectRoot,
    env: hostChildEnvironment(databaseUrl),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function connectDockerClient(
  name: string,
  databaseUrl: string,
  imageName: string,
): Promise<ClientHarness> {
  const client: Client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport: StdioClientTransport = new StdioClientTransport({
    args: [
      "run",
      "--rm",
      "--interactive",
      "--mount",
      `type=bind,source=${projectRoot},target=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--env",
      "MURMUR_DATABASE_URL",
      "--env",
      "MURMUR_BRANCH",
      "--env",
      "MURMUR_CLIENT",
      "--env",
      "MURMUR_REPOSITORY",
      imageName,
      "bun",
      "run",
      "src/server.ts",
    ],
    command: "docker",
    env: hostChildEnvironment(databaseUrl),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function callValidated<T>(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const rawResult: unknown = await client.callTool({
    arguments: argumentsValue,
    name,
  });
  const result: CallToolResult = CallToolResultSchema.parse(rawResult);
  if (result.isError === true) {
    throw new Error(`MCP tool '${name}' failed: ${JSON.stringify(result.content)}`);
  }
  return schema.parse(result.structuredContent);
}

async function notificationTimeout(): Promise<never> {
  await Bun.sleep(8_000);
  throw new Error("Cloud push notification timed out");
}

async function waitForMessageCommitLockWaiters(
  database: Sql,
  recipientId: string,
  expected: number,
): Promise<void> {
  let attempt: number = 0;
  while (attempt < 200) {
    const rows: AdvisoryWaiterCountRow[] = await database<AdvisoryWaiterCountRow[]>`
      SELECT COUNT(*) AS count
      FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory'
        AND classid = (
          pg_catalog.hashtextextended(
            ${recipientId},
            ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
          ) >> 32 & 4294967295::bigint
        )::oid
        AND objid = (
          pg_catalog.hashtextextended(
            ${recipientId},
            ${POSTGRES_MESSAGE_RECIPIENT_LOCK_SEED}::bigint
          ) & 4294967295::bigint
        )::oid
        AND objsubid = 1
        AND NOT granted
    `;
    const row: AdvisoryWaiterCountRow | undefined = rows[0];
    if (row === undefined) throw new Error("Postgres did not return an advisory lock count");
    if (Number(row.count) >= expected) return;
    await Bun.sleep(10);
    attempt += 1;
  }
  throw new Error(`Timed out waiting for ${String(expected)} message commit lock waiters`);
}

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
            ssl: "require",
          });
          const lockHeld: DeferredSignal = deferredSignal();
          const commitLockReleased: DeferredSignal = deferredSignal();
          const lockHolder: Promise<unknown> = coordinationDatabase.begin(
            async (transaction: TransactionSql): Promise<void> => {
              await transaction`
                SELECT pg_catalog.pg_advisory_xact_lock(
                  pg_catalog.hashtextextended(
                    ${receiverId},
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
                audience: { machine: machineName, repository: repositoryName },
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
