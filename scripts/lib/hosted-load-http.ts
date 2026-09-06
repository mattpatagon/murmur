import { randomBytes } from "node:crypto";

import {
  CallToolResultSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type InboxOutput,
  InboxOutputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
  type MessageDto,
  type RegisterAgentOutput,
  RegisterAgentOutputSchema,
  type SendMessageOutput,
  SendMessageOutputSchema,
} from "../../src/domain/contracts.js";
import { HostedLoadFailure, requireLoad } from "./hosted-load-config.js";
import type { LoadTenant } from "./hosted-load-fixture.js";
import {
  isLoadCapacityResponse,
  LOAD_HTTP_RUNTIME,
  type LoadHttpRuntime,
} from "./hosted-load-http-runtime.js";
import type { LoadPhase } from "./hosted-load-metrics.js";

type HttpResult = { readonly headers: Headers; readonly payload: unknown; readonly status: number };
type FailureStage = "fetch" | "body-read" | "body-parse";
const EnvelopeSchema: z.ZodType<{ result: unknown }> = z.object({ result: z.unknown() });
const ErrorSchema: z.ZodType<{ error: string }> = z.object({ error: z.string().max(200) });
const FailureLabelSchema: z.ZodType<string> = z.enum([
  "ConnectionClosed",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ABORT_ERR",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "SyntaxError",
]);

function failureLabel(error: unknown): string {
  if (!(error instanceof Error)) return "unclassified";
  if ("code" in error) {
    const code: z.ZodSafeParseResult<string> = FailureLabelSchema.safeParse(error.code);
    if (code.success) return code.data;
  }
  const name: z.ZodSafeParseResult<string> = FailureLabelSchema.safeParse(error.name);
  return name.success ? name.data : "unclassified";
}

function headers(token: string, session: string | null): Headers {
  const result: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Repository": "load/disposable",
    "X-Murmur-Branch": "load-test",
    "X-Murmur-Client": "codex",
  });
  if (session !== null) {
    result.set("Mcp-Session-Id", session);
    result.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return result;
}

function initializeBody(): Record<string, unknown> {
  return {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "murmur-disposable-load", version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  };
}

async function payload(
  response: Response,
  onStage: (stage: FailureStage) => void = (): void => {},
): Promise<unknown> {
  onStage("body-read");
  if (response.body === null) return null;
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size: number = 0;
  try {
    while (true) {
      const next: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>> =
        await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      requireLoad(size <= 1_048_576, "Load response exceeded its byte budget");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  onStage("body-parse");
  const body: string = Buffer.concat(chunks).toString("utf8");
  if (body === "") return null;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const event: string | undefined = body
      .split("\n")
      .filter((line: string): boolean => line.startsWith("data: "))
      .at(-1);
    requireLoad(event !== undefined, "Load RPC returned no event data");
    return JSON.parse(event.slice(6));
  }
  return JSON.parse(body);
}

export class LoadHttpClient {
  public constructor(
    public readonly url: URL,
    public readonly phase: LoadPhase,
    private readonly signal: AbortSignal,
    private readonly runtime: LoadHttpRuntime = LOAD_HTTP_RUNTIME,
  ) {}

  public async request(
    token: string,
    session: string | null,
    body: Record<string, unknown> | null,
    method: "POST" | "DELETE",
    expected: readonly number[],
    retry: boolean = true,
  ): Promise<HttpResult> {
    const started: number = this.runtime.now();
    const deadline: number = started + 15_000;
    for (let attempt: number = 0; attempt < 8; attempt += 1) {
      this.signal.throwIfAborted();
      const before: number = this.runtime.now();
      requireLoad(before < deadline, "Load request exceeded its bounded request deadline");
      let response: Response;
      let result: unknown;
      let status: number = 0;
      let stage: FailureStage = "fetch";
      try {
        response = await this.runtime.fetch(this.url, {
          method,
          headers: headers(token, session),
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([
            this.signal,
            AbortSignal.timeout(Math.max(1, Math.floor(Math.min(10_000, deadline - before)))),
          ]),
        });
        status = response.status;
        result = await payload(response, (nextStage: FailureStage): void => {
          stage = nextStage;
        });
      } catch (error: unknown) {
        this.phase.recordAttempt(status, this.runtime.now() - before);
        throw new HostedLoadFailure(
          `Load HTTP request failed (stage=${stage}, label=${failureLabel(error)}, status=${status})`,
        );
      }
      this.phase.recordAttempt(response.status, this.runtime.now() - before);
      const capacity: boolean = response.status === 200 && isLoadCapacityResponse(result, body);
      if (capacity) this.phase.mcpCapacityResponses += 1;
      this.signal.throwIfAborted();
      requireLoad(
        this.runtime.now() < deadline,
        "Load request exceeded its bounded request deadline",
      );
      if (expected.includes(response.status) && !capacity) {
        this.phase.recordOperation(this.runtime.now() - started);
        return { headers: response.headers, payload: result, status: response.status };
      }
      if (
        !retry ||
        (!capacity && response.status !== 503 && response.status !== 429) ||
        attempt === 7
      ) {
        if (capacity)
          throw new HostedLoadFailure("Load MCP capacity exhausted its bounded retries");
        throw new HostedLoadFailure(`Unexpected hosted load HTTP status ${response.status}`);
      }
      const retryAfter: string | null = response.headers.get("retry-after");
      const delay: number = capacity
        ? 1_000
        : retryAfter === null
          ? 100 * (attempt + 1)
          : Number(retryAfter) * 1_000;
      const wait: number = delay + attempt * 7;
      requireLoad(
        Number.isFinite(delay) &&
          delay >= 0 &&
          delay <= 10_000 &&
          this.runtime.now() + wait < deadline,
        "Load retry exceeds its bounded request deadline",
      );
      this.phase.retries += 1;
      await this.runtime.wait(wait, this.signal);
    }
    throw new HostedLoadFailure("Load request exhausted retries");
  }

  public async initialize(tenant: LoadTenant): Promise<string> {
    const result: HttpResult = await this.request(
      tenant.token.secret,
      null,
      initializeBody(),
      "POST",
      [200],
    );
    const envelope: { result: unknown } = EnvelopeSchema.parse(result.payload);
    const initialization: z.infer<typeof InitializeResultSchema> = InitializeResultSchema.parse(
      envelope.result,
    );
    requireLoad(
      initialization.protocolVersion === LATEST_PROTOCOL_VERSION,
      "Hosted initialize returned an unexpected protocol",
    );
    const session: string | null = result.headers.get("mcp-session-id");
    requireLoad(session !== null, "Hosted initialize omitted its session");
    try {
      await this.request(
        tenant.token.secret,
        session,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "POST",
        [202],
      );
      return session;
    } catch (error: unknown) {
      await this.disconnect(tenant, session);
      throw error;
    }
  }

  public async disconnect(tenant: LoadTenant, session: string): Promise<void> {
    await this.request(tenant.token.secret, session, null, "DELETE", [200, 404]);
  }

  public async tool<T>(
    tenant: LoadTenant,
    session: string,
    name: string,
    arguments_: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const result: HttpResult = await this.request(
      tenant.token.secret,
      session,
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: arguments_ },
      },
      "POST",
      [200],
    );
    const envelope: { result: unknown } = EnvelopeSchema.parse(result.payload);
    const tool: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
    requireLoad(tool.isError !== true, "Hosted load tool returned an error");
    return schema.parse(tool.structuredContent);
  }

  public async journey(tenant: LoadTenant, run: string): Promise<void> {
    const session: string = await this.initialize(tenant);
    try {
      for (const agentId of ["load-sender", "load-recipient"]) {
        const registration: RegisterAgentOutput = await this.tool(
          tenant,
          session,
          "register_agent",
          { agent_id: agentId },
          RegisterAgentOutputSchema,
        );
        requireLoad(
          registration.agent.agent_id === agentId && registration.agent.state === "active",
          "Hosted registration returned the wrong identity",
        );
      }
      const inboxArguments: Record<string, unknown> = {
        agent_id: "load-recipient",
        after_sequence: 0,
        limit: 10,
        unread_only: true,
      };
      const before: InboxOutput = await this.tool(
        tenant,
        session,
        "get_messages",
        inboxArguments,
        InboxOutputSchema,
      );
      requireLoad(before.messages.length === 0, "Tenant inbox contained unexpected unread data");
      const content: string = `${run}:${tenant.id}`;
      const arguments_: Record<string, unknown> = {
        sender_id: "load-sender",
        recipient_id: "load-recipient",
        content,
        idempotency_key: run,
      };
      const sent: SendMessageOutput = await this.tool(
        tenant,
        session,
        "send_message",
        arguments_,
        SendMessageOutputSchema,
      );
      requireLoad(
        !sent.duplicate &&
          sent.message.content === content &&
          sent.message.sender_authority === "peer",
        "Hosted send semantics failed",
      );
      const duplicate: SendMessageOutput = await this.tool(
        tenant,
        session,
        "send_message",
        arguments_,
        SendMessageOutputSchema,
      );
      requireLoad(
        duplicate.duplicate && duplicate.message.message_id === sent.message.message_id,
        "Hosted idempotent retry changed delivery",
      );
      const inbox: InboxOutput = await this.tool(
        tenant,
        session,
        "get_messages",
        inboxArguments,
        InboxOutputSchema,
      );
      const delivered: MessageDto | undefined = inbox.messages[0];
      requireLoad(
        inbox.agent_id === "load-recipient" &&
          inbox.messages.length === 1 &&
          delivered !== undefined &&
          delivered.message_id === sent.message.message_id &&
          delivered.content === content,
        "Tenant inbox isolation or message identity failed",
      );
      const read: MarkMessagesReadOutput = await this.tool(
        tenant,
        session,
        "mark_messages_read",
        { agent_id: "load-recipient", message_ids: [sent.message.message_id] },
        MarkMessagesReadOutputSchema,
      );
      requireLoad(read.updated === 1, "Hosted acknowledgement updated the wrong row count");
      const after: InboxOutput = await this.tool(
        tenant,
        session,
        "get_messages",
        inboxArguments,
        InboxOutputSchema,
      );
      requireLoad(after.messages.length === 0, "Hosted acknowledgement left unread data");
    } finally {
      await this.disconnect(tenant, session);
    }
  }

  public async forged(
    tenant: LoadTenant,
    kind: "malformed" | "known-key" | "unknown-key",
  ): Promise<void> {
    const key: string =
      kind === "unknown-key" ? randomBytes(6).toString("base64url") : tenant.token.keyId;
    const token: string =
      kind === "malformed"
        ? "invalid-load-credential"
        : `mur_${key}_${randomBytes(32).toString("base64url")}`;
    const result: HttpResult = await this.request(
      token,
      null,
      initializeBody(),
      "POST",
      [401, 503],
      false,
    );
    if (result.status === 401) {
      requireLoad(
        result.payload === null &&
          (result.headers.get("www-authenticate") ?? "").startsWith("Bearer "),
        "Invalid credential did not receive the fixed bearer challenge",
      );
    } else {
      const error: { error: string } = ErrorSchema.parse(result.payload);
      requireLoad(
        error.error === "Authentication capacity reached",
        "Invalid credential reached an unexpected gate",
      );
    }
    requireLoad(
      result.headers.get("mcp-session-id") === null,
      "Rejected credential received a session",
    );
  }

  public async foreignSession(tenant: LoadTenant, session: string): Promise<void> {
    const result: HttpResult = await this.request(
      tenant.token.secret,
      session,
      { id: 1, jsonrpc: "2.0", method: "tools/list" },
      "POST",
      [404],
    );
    const error: { error: string } = ErrorSchema.parse(result.payload);
    requireLoad(
      error.error === "MCP session not found",
      "Cross-tenant session probe returned unexpected semantics",
    );
  }

  public async saturatedInitialize(tenant: LoadTenant): Promise<void> {
    const result: HttpResult = await this.request(
      tenant.token.secret,
      null,
      initializeBody(),
      "POST",
      [503],
      false,
    );
    const error: { error: string } = ErrorSchema.parse(result.payload);
    requireLoad(
      error.error === "MCP session capacity reached",
      "Session saturation did not reach its intended gate",
    );
  }

  public async stream(tenant: LoadTenant, session: string, expected: number): Promise<Response> {
    const started: number = performance.now();
    const controller: AbortController = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(this.url, {
        headers: headers(tenant.token.secret, session),
        signal: AbortSignal.any([this.signal, controller.signal]),
      });
    } finally {
      clearTimeout(timer);
    }
    this.phase.recordAttempt(response.status, performance.now() - started);
    requireLoad(
      response.status === expected,
      "Standalone stream admission returned unexpected status",
    );
    if (expected !== 200) {
      const error: { error: string } = ErrorSchema.parse(await payload(response));
      requireLoad(
        error.error === "MCP stream capacity reached",
        "Stream saturation reached the wrong gate",
      );
    }
    return response;
  }
}
