import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { approveExactRequest } from "../../src/admin/approval-request.js";
import {
  type ProductionStreamRuntime,
  requireProductionStream,
} from "./production-stream-contracts.js";
import { streamDeadline } from "./production-stream-io.js";
import {
  ProductionStreamFetch,
  type ProductionStreamRecorder,
} from "./production-stream-transport.js";

type ApprovedTool = "create_access_token" | "revoke_access_token" | "suspend_tenant";
type Approval = { readonly name: ApprovedTool; readonly input: Record<string, unknown> };

export class ProductionStreamApproval {
  private pending: Approval | null = null;
  private answered: boolean = false;

  public answer(request: ElicitRequest): ElicitResult {
    if (this.pending === null || this.answered) return { action: "decline" };
    const result: ElicitResult = approveExactRequest(
      request,
      this.pending.name,
      this.pending.input,
    );
    if (result.action === "accept") this.answered = true;
    return result;
  }

  public async run<T>(
    name: ApprovedTool,
    input: Record<string, unknown>,
    operation: (exact: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    requireProductionStream(this.pending === null);
    const exact: Record<string, unknown> = structuredClone(input);
    this.pending = { name, input: structuredClone(exact) };
    this.answered = false;
    try {
      return await operation(exact);
    } finally {
      this.pending = null;
      this.answered = false;
    }
  }
}

export function productionStreamHeaders(token: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "X-Murmur-Repository": "canary/production-stream",
    "X-Murmur-Branch": "production-stream",
    "X-Murmur-Client": "codex",
  });
}

export class ProductionStreamClient {
  public readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly boundedFetch: ProductionStreamFetch;
  private readonly approval: ProductionStreamApproval = new ProductionStreamApproval();
  private closed: boolean = false;
  private closeFailed: boolean = false;
  private closing: Promise<void> | null = null;

  public constructor(
    private readonly endpoint: URL,
    private readonly token: string,
    private readonly runtime: ProductionStreamRuntime,
    recorder: ProductionStreamRecorder | null = null,
    reconnectionDelayMs: number = 1_000,
  ) {
    this.boundedFetch = new ProductionStreamFetch(endpoint, runtime.fetch, recorder);
    this.client = new Client(
      { name: "murmur-production-stream", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    this.client.setRequestHandler(
      ElicitRequestSchema,
      (request: ElicitRequest): ElicitResult => this.approval.answer(request),
    );
    this.client.onerror = (_error: Error): void => {
      if (!this.closed && recorder !== null) recorder.fail();
    };
    this.transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: this.boundedFetch.fetch,
      requestInit: { headers: productionStreamHeaders(token) },
      reconnectionOptions: {
        initialReconnectionDelay: reconnectionDelayMs,
        maxReconnectionDelay: 5_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 3,
      },
    });
  }

  private async scoped<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    return await streamDeadline(
      async (signal: AbortSignal): Promise<T> => {
        const abort: () => void = (): void => {
          this.closed = true;
          this.boundedFetch.abort();
          void this.client.close().catch((_error: unknown): void => {
            this.closeFailed = true;
          });
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          return await operation(signal);
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      20_000,
      outerSignal,
    );
  }

  public async connect(outerSignal?: AbortSignal): Promise<void> {
    await this.scoped(
      async (signal: AbortSignal): Promise<void> =>
        await this.client.connect(this.transport, {
          signal,
          timeout: 20_000,
          maxTotalTimeout: 20_000,
        }),
      outerSignal,
    );
  }

  public async execute<T>(
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return await this.scoped(
      async (bounded: AbortSignal): Promise<T> => await operation(this.client, bounded),
      signal,
    );
  }

  public async call<T>(
    name: string,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    return await this.scoped(async (signal: AbortSignal): Promise<T> => {
      const result: Awaited<ReturnType<Client["callTool"]>> = await this.client.callTool(
        { name, arguments: input },
        CallToolResultSchema,
        { signal, timeout: 20_000, maxTotalTimeout: 20_000 },
      );
      requireProductionStream(result.isError !== true);
      return schema.parse(result.structuredContent);
    }, outerSignal);
  }

  public async approved<T>(
    name: ApprovedTool,
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.approval.run(
      name,
      input,
      async (exact: Record<string, unknown>): Promise<T> =>
        await this.call(name, exact, schema, signal),
    );
  }

  public close(signal?: AbortSignal): Promise<void> {
    if (this.closing === null) this.closing = this.closeOnce(signal);
    return this.closing;
  }

  private async closeOnce(outerSignal?: AbortSignal): Promise<void> {
    this.closed = true;
    const session: string | undefined = this.transport.sessionId;
    const results: PromiseSettledResult<void>[] = await Promise.allSettled([
      streamDeadline(async (): Promise<void> => await this.client.close(), 5_000),
      this.boundedFetch.close(),
    ]);
    let deleted: boolean = true;
    if (session !== undefined) {
      try {
        await streamDeadline(
          async (signal: AbortSignal): Promise<void> => {
            const headers: Headers = productionStreamHeaders(this.token);
            headers.set("mcp-session-id", session);
            headers.set("mcp-protocol-version", LATEST_PROTOCOL_VERSION);
            for (let attempt: number = 0; attempt < 3; attempt += 1) {
              signal.throwIfAborted();
              const response: Response = await this.runtime.fetch(this.endpoint, {
                method: "DELETE",
                headers,
                redirect: "error",
                signal,
              });
              if (response.body !== null) await response.body.cancel();
              if (response.status === 503 && attempt < 2) {
                // Revoked credentials lose queued admission; concurrent closes can hit its bound.
                await this.runtime.clock.sleep(1_000, signal);
                continue;
              }
              requireProductionStream([200, 401, 404].includes(response.status));
              return;
            }
          },
          20_000,
          outerSignal,
        );
      } catch (_error: unknown) {
        deleted = false;
      }
    }
    requireProductionStream(
      deleted &&
        !this.closeFailed &&
        results.every(
          (result: PromiseSettledResult<void>): boolean => result.status === "fulfilled",
        ),
    );
  }
}
