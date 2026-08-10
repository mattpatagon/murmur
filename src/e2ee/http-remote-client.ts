import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import {
  type ListAgentsInput,
  ListAgentsInputSchema,
  type ListAgentsOutput,
  ListAgentsOutputSchema,
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type RegisterAgentInput,
  RegisterAgentInputSchema,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
} from "../domain/contracts.js";
import { BoundedHttpClientTransport } from "./bounded-http-transport.js";
import {
  type E2eeRemoteClient,
  type E2eeProxyRemoteClient,
  ENCRYPTION_CLAIM_EXPIRED_MESSAGE,
  EncryptionClaimExpiredError,
} from "./remote-client.js";
import {
  type CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastInputSchema,
  type CancelEncryptedBroadcastOutput,
  CancelEncryptedBroadcastOutputSchema,
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastInputSchema,
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
  E2eeCapabilityInputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityOutputSchema,
  E2eeMessageContextDtoSchema,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type GetEncryptedMessagesInput,
  GetEncryptedMessagesInputSchema,
  type GetInboxSummaryInput,
  GetInboxSummaryInputSchema,
  type GetInboxSummaryOutput,
  GetInboxSummaryOutputSchema,
  type PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastInputSchema,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PublishAgentKeyBundleInput,
  PublishAgentKeyBundleInputSchema,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
  type PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryInputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
  type WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesInputSchema,
  type WaitForEncryptedMessagesOutput,
  WaitForEncryptedMessagesOutputSchema,
} from "./wire-tools.js";

const CONNECT_TIMEOUT_MS: number = 10_000;
const REQUEST_TIMEOUT_MS: number = 30_000;
const WAIT_RESPONSE_GRACE_MS: number = 5_000;
const TOKEN_PATTERN: RegExp = /^[\x21-\x7e]{1,256}$/u;
const CLAIM_EXPIRED_CONTENT: string = JSON.stringify(
  { error: ENCRYPTION_CLAIM_EXPIRED_MESSAGE },
  null,
  2,
);

export type E2eeHttpRemoteClientConfig = {
  readonly branch: string | null;
  readonly client: "claude" | "codex";
  readonly endpoint: string;
  readonly repository: string | null;
  readonly token: string;
};

export interface E2eeWireToolCaller {
  call(name: string, input: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

class McpWireToolCaller implements E2eeWireToolCaller {
  readonly #client: Client;

  private constructor(client: Client) {
    this.#client = client;
  }

  public static async connect(config: E2eeHttpRemoteClientConfig): Promise<McpWireToolCaller> {
    const endpoint: URL = parseEndpoint(config.endpoint);
    const context: { branch: string; client: "claude" | "codex"; repository: string } | null =
      config.branch === null || config.repository === null
        ? null
        : E2eeMessageContextDtoSchema.parse({
            branch: config.branch,
            client: config.client,
            repository: config.repository,
          });
    if (!TOKEN_PATTERN.test(config.token)) {
      throw new Error("The encrypted Murmur access token is invalid");
    }
    const headers: Headers = new Headers({
      Authorization: `Bearer ${config.token}`,
      "X-Murmur-Client": config.client,
    });
    if (context !== null) {
      headers.set("X-Murmur-Branch", context.branch);
      headers.set("X-Murmur-Repository", context.repository);
    }
    const transport: BoundedHttpClientTransport = new BoundedHttpClientTransport(endpoint, headers);
    const client: Client = new Client(
      { name: "murmur-e2ee-proxy", version: "1.0.0" },
      { capabilities: {}, enforceStrictCapabilities: true },
    );
    try {
      await client.connect(transport, {
        maxTotalTimeout: CONNECT_TIMEOUT_MS,
        timeout: CONNECT_TIMEOUT_MS,
      });
    } catch (_error: unknown) {
      await client.close().catch((_closeError: unknown): void => undefined);
      throw new Error("The encrypted Murmur service connection failed");
    }
    return new McpWireToolCaller(client);
  }

  public async call(
    name: string,
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<unknown> {
    return await this.#client.callTool({ arguments: input, name }, CallToolResultSchema, {
      maxTotalTimeout: timeoutMs,
      timeout: timeoutMs,
    });
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (_error: unknown) {
    throw new Error("The encrypted Murmur endpoint URL is invalid");
  }
  const loopback: boolean =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("The encrypted Murmur endpoint must use HTTPS outside loopback");
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("The encrypted Murmur endpoint URL may not contain credentials or parameters");
  }
  return endpoint;
}

function inputRecord<T extends object>(
  schema: z.ZodType<T>,
  input: T,
): Readonly<Record<string, unknown>> {
  const parsed: T = schema.parse(input);
  return Object.fromEntries(Object.entries(parsed));
}

function isClaimExpired(result: CallToolResult): boolean {
  return result.content.some(
    (item: CallToolResult["content"][number]): boolean =>
      item.type === "text" && item.text === CLAIM_EXPIRED_CONTENT,
  );
}

export class E2eeHttpRemoteClient implements E2eeRemoteClient, E2eeProxyRemoteClient {
  readonly #caller: E2eeWireToolCaller;
  #closed: boolean = false;

  public constructor(caller: E2eeWireToolCaller) {
    this.#caller = caller;
  }

  public static async connect(config: E2eeHttpRemoteClientConfig): Promise<E2eeHttpRemoteClient> {
    return new E2eeHttpRemoteClient(await McpWireToolCaller.connect(config));
  }

  private async call<TInput extends object, TOutput>(
    name: string,
    input: TInput,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<TOutput> {
    if (this.#closed) throw new Error("The encrypted Murmur remote client is closed");
    let rawResult: unknown;
    try {
      rawResult = await this.#caller.call(name, inputRecord(inputSchema, input), timeoutMs);
    } catch (_error: unknown) {
      throw new Error("The encrypted Murmur service request failed");
    }
    const parsedResult: z.ZodSafeParseResult<CallToolResult> =
      CallToolResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      throw new Error("The encrypted Murmur service returned an invalid response");
    }
    const result: CallToolResult = parsedResult.data;
    if (result.isError === true) {
      if (isClaimExpired(result)) throw new EncryptionClaimExpiredError();
      throw new Error("The encrypted Murmur service rejected the request");
    }
    const output: z.ZodSafeParseResult<TOutput> = outputSchema.safeParse(result.structuredContent);
    if (!output.success) {
      throw new Error("The encrypted Murmur service returned an invalid response");
    }
    return output.data;
  }

  public async capability(): Promise<E2eeCapabilityOutput> {
    return await this.call(
      "get_e2ee_capability",
      {},
      E2eeCapabilityInputSchema,
      E2eeCapabilityOutputSchema,
    );
  }

  public async registerAgent(input: RegisterAgentInput): Promise<RegisterAgentOutput> {
    return await this.call(
      "register_agent",
      input,
      RegisterAgentInputSchema,
      RegisterAgentOutputSchema,
    );
  }

  public async listAgents(input: ListAgentsInput): Promise<ListAgentsOutput> {
    return await this.call("list_agents", input, ListAgentsInputSchema, ListAgentsOutputSchema);
  }

  public async publishAgentKeyBundle(
    input: PublishAgentKeyBundleInput,
  ): Promise<PublishAgentKeyBundleOutput> {
    return await this.call(
      "publish_agent_key_bundle",
      input,
      PublishAgentKeyBundleInputSchema,
      PublishAgentKeyBundleOutputSchema,
    );
  }

  public async claimEncryptionPrekey(
    input: ClaimEncryptionPrekeyInput,
  ): Promise<ClaimEncryptionPrekeyOutput> {
    return await this.call(
      "claim_encryption_prekey",
      input,
      ClaimEncryptionPrekeyInputSchema,
      ClaimEncryptionPrekeyOutputSchema,
    );
  }

  public async putEncryptedMessage(
    input: PutEncryptedMessageInput,
  ): Promise<PutEncryptedMessageOutput> {
    return await this.call(
      "put_encrypted_message",
      input,
      PutEncryptedMessageInputSchema,
      PutEncryptedMessageOutputSchema,
    );
  }

  public async getEncryptedMessages(
    input: GetEncryptedMessagesInput,
  ): Promise<EncryptedInboxOutput> {
    return await this.call(
      "get_encrypted_messages",
      input,
      GetEncryptedMessagesInputSchema,
      EncryptedInboxOutputSchema,
    );
  }

  public async waitForEncryptedMessages(
    input: WaitForEncryptedMessagesInput,
  ): Promise<WaitForEncryptedMessagesOutput> {
    const parsed: WaitForEncryptedMessagesInput = WaitForEncryptedMessagesInputSchema.parse(input);
    return await this.call(
      "wait_for_encrypted_messages",
      parsed,
      WaitForEncryptedMessagesInputSchema,
      WaitForEncryptedMessagesOutputSchema,
      parsed.timeout_seconds * 1_000 + WAIT_RESPONSE_GRACE_MS,
    );
  }

  public async markMessagesRead(input: MarkMessagesReadInput): Promise<MarkMessagesReadOutput> {
    return await this.call(
      "mark_messages_read",
      input,
      MarkMessagesReadInputSchema,
      MarkMessagesReadOutputSchema,
    );
  }

  public async prepareEncryptedBroadcast(
    input: PrepareEncryptedBroadcastInput,
  ): Promise<PrepareEncryptedBroadcastOutput> {
    return await this.call(
      "prepare_encrypted_broadcast",
      input,
      PrepareEncryptedBroadcastInputSchema,
      PrepareEncryptedBroadcastOutputSchema,
    );
  }

  public async putEncryptedBroadcastDelivery(
    input: PutEncryptedBroadcastDeliveryInput,
  ): Promise<PutEncryptedBroadcastDeliveryOutput> {
    return await this.call(
      "put_encrypted_broadcast_delivery",
      input,
      PutEncryptedBroadcastDeliveryInputSchema,
      PutEncryptedBroadcastDeliveryOutputSchema,
    );
  }

  public async commitEncryptedBroadcast(
    input: CommitEncryptedBroadcastInput,
  ): Promise<CommitEncryptedBroadcastOutput> {
    return await this.call(
      "commit_encrypted_broadcast",
      input,
      CommitEncryptedBroadcastInputSchema,
      CommitEncryptedBroadcastOutputSchema,
    );
  }

  public async cancelEncryptedBroadcast(
    input: CancelEncryptedBroadcastInput,
  ): Promise<CancelEncryptedBroadcastOutput> {
    return await this.call(
      "cancel_encrypted_broadcast",
      input,
      CancelEncryptedBroadcastInputSchema,
      CancelEncryptedBroadcastOutputSchema,
    );
  }

  public async getInboxSummary(input: GetInboxSummaryInput): Promise<GetInboxSummaryOutput> {
    return await this.call(
      "get_inbox_summary",
      input,
      GetInboxSummaryInputSchema,
      GetInboxSummaryOutputSchema,
    );
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#caller.close();
    } catch (_error: unknown) {
      throw new Error("The encrypted Murmur service shutdown failed");
    }
  }
}
