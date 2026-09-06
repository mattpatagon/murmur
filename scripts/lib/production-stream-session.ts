import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  type ResourceUpdatedNotification,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  type InboxOutput,
  InboxOutputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
} from "../../src/domain/contracts.js";
import { ProductionStreamClient } from "./production-stream-client.js";
import {
  type ProductionStreamRuntime,
  type ProductionStreamSession,
  type ProductionStreamSnapshot,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamDeadline } from "./production-stream-io.js";
import { ProductionStreamRecorder } from "./production-stream-transport.js";

export class ProductionStreamAgent implements ProductionStreamSession {
  private readonly recorder: ProductionStreamRecorder;
  private readonly connection: ProductionStreamClient;
  private readonly sender: string = "production-stream-sender";
  private readonly receiver: string = "production-stream-receiver";
  private readonly uri: string = `murmur://inbox/${this.receiver}`;
  private notifications: number = 0;

  public constructor(
    endpoint: URL,
    token: string,
    private readonly runtime: ProductionStreamRuntime,
    reconnectionDelayMs: number = 1_000,
  ) {
    this.recorder = new ProductionStreamRecorder(runtime.clock);
    this.connection = new ProductionStreamClient(
      endpoint,
      token,
      runtime,
      this.recorder,
      reconnectionDelayMs,
    );
    this.connection.client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification: ResourceUpdatedNotification): void => {
        if (notification.params.uri === this.uri) this.notifications += 1;
        if (this.notifications > 16) this.recorder.fail();
      },
    );
  }

  public snapshot(): ProductionStreamSnapshot {
    return this.recorder.snapshot();
  }

  public async start(outerSignal: AbortSignal): Promise<void> {
    await this.connection.connect(outerSignal);
    for (const agentId of [this.sender, this.receiver]) {
      const result: RegisterAgentOutput = await this.connection.call(
        "register_agent",
        { agent_id: agentId },
        RegisterAgentOutputSchema,
        outerSignal,
      );
      requireProductionStream(result.agent.agent_id === agentId && result.agent.state === "active");
    }
    await streamDeadline(
      async (signal: AbortSignal): Promise<void> => {
        while (this.recorder.snapshot().successfulGets === 0) {
          requireProductionStream(!this.recorder.snapshot().invalid);
          await this.runtime.clock.sleep(100, signal);
        }
      },
      20_000,
      outerSignal,
    );
  }

  public async subscribe(outerSignal: AbortSignal): Promise<void> {
    await this.connection.execute(async (client: Client, signal: AbortSignal): Promise<void> => {
      await client.subscribeResource(
        { uri: this.uri },
        { signal, timeout: 20_000, maxTotalTimeout: 20_000 },
      );
    }, outerSignal);
  }

  public async keepAlive(outerSignal: AbortSignal): Promise<void> {
    await this.connection.execute(async (client: Client, signal: AbortSignal): Promise<void> => {
      await client.ping({ signal, timeout: 20_000, maxTotalTimeout: 20_000 });
    }, outerSignal);
  }

  public async proveDelivery(outerSignal: AbortSignal): Promise<void> {
    requireProductionStream(this.recorder.snapshot().successfulGets >= 2);
    const prior: number = this.notifications;
    const content: string = `Production stream delivery ${randomUUID()}`;
    const sent: SendMessageOutput = await this.connection.call(
      "send_message",
      {
        sender_id: this.sender,
        recipient_id: this.receiver,
        content,
        idempotency_key: randomUUID(),
      },
      SendMessageOutputSchema,
      outerSignal,
    );
    requireProductionStream(
      !sent.duplicate &&
        sent.message.content === content &&
        sent.message.sender_id === this.sender &&
        sent.message.recipient_id === this.receiver,
    );
    await this.connection.execute(async (client: Client, signal: AbortSignal): Promise<void> => {
      while (this.notifications <= prior) {
        requireProductionStream(!this.recorder.snapshot().invalid);
        await this.runtime.clock.sleep(100, signal);
      }
      const result: Awaited<ReturnType<Client["readResource"]>> = await client.readResource(
        { uri: this.uri },
        { signal, timeout: 20_000, maxTotalTimeout: 20_000 },
      );
      requireProductionStream(result.contents.length === 1);
      const item: (typeof result.contents)[number] | undefined = result.contents[0];
      requireProductionStream(
        item !== undefined &&
          item.uri === this.uri &&
          "text" in item &&
          typeof item.text === "string" &&
          Buffer.byteLength(item.text) <= 1_048_576,
      );
      const decoded: unknown = JSON.parse(item.text);
      const inbox: InboxOutput = InboxOutputSchema.parse(decoded);
      const message: InboxOutput["messages"][number] | undefined = inbox.messages[0];
      requireProductionStream(
        inbox.agent_id === this.receiver &&
          inbox.messages.length === 1 &&
          message !== undefined &&
          message.message_id === sent.message.message_id &&
          message.content === content &&
          message.sender_id === this.sender &&
          message.recipient_id === this.receiver,
      );
    }, outerSignal);
  }

  public async close(signal: AbortSignal): Promise<void> {
    await this.connection.close(signal);
  }
}
