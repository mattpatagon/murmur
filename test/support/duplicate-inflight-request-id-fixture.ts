import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type EmptyResult,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  PingRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HttpRequestIdAdmission } from "../../src/http/request-id-admission.js";
import { responseWithFinish } from "../../src/http/response-lifecycle.js";
import {
  MaterializationByteBudget,
  type MaterializationReservation,
  MaterializationScope,
  reserveMaterializationBytes,
  withMaterializationScope,
} from "../../src/materialization-budget.js";
import { MurmurApplication } from "../../src/mcp/murmur-application.js";
import { currentRequestIdClaim, type RequestIdClaim } from "../../src/request-id-admission.js";
import { initializeRequest, requestHeaders, responsePayload } from "./http-mcp-harness.js";

type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };
export type RequestId = string | number;
type SendOptions = Parameters<WebStandardStreamableHTTPServerTransport["send"]>[1];
export const COUNTED_BYTES: number = 256;
const COUNTED_URI: string = "murmur://inbox/counted-owner";
export const COUNTED_RESULT: ReadResourceResult = {
  contents: [{ uri: COUNTED_URI, mimeType: "text/plain", text: "small counted payload" }],
};

export class DuplicateIdFixture {
  public readonly admission: HttpRequestIdAdmission;
  public readonly budget: MaterializationByteBudget = new MaterializationByteBudget(COUNTED_BYTES);
  public readonly countedEntered: Gate = Promise.withResolvers<void>();
  public readonly countedRelease: Gate = Promise.withResolvers<void>();
  public readonly countedSent: Gate = Promise.withResolvers<void>();
  public readonly countedFinished: Gate = Promise.withResolvers<void>();
  public readonly sendEntered: Gate = Promise.withResolvers<void>();
  public readonly sendRelease: Gate = Promise.withResolvers<void>();
  public readonly cheapEntered: Gate = Promise.withResolvers<void>();
  public readonly cheapRelease: Gate = Promise.withResolvers<void>();
  public readonly cheapSent: Gate = Promise.withResolvers<void>();
  public readonly finishedResponses: Set<string> = new Set<string>();
  public bytesAtCountedSend: number | null = null;
  public countedSendSucceeded: boolean = false;
  public holdCountedSend: boolean = false;
  public countedSignal: AbortSignal | null = null;
  private countedSendStarted: boolean = false;
  private countedHandlerReturned: boolean = false;
  private countedId: RequestId | null = null;
  public cheapHandlerFinished: boolean = false;
  public protocolErrors: number = 0;
  private countedStarted: boolean = false;
  private cheapStarted: boolean = false;
  private cheapId: RequestId | null = null;
  private readonly responses: Response[] = [];
  public readonly application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    repositoryName: null,
    reserveProcessingCapacity: (): (() => void) => (): void => {
      const claim: RequestIdClaim | undefined = currentRequestIdClaim();
      if (this.countedHandlerReturned && claim !== undefined && claim.id === this.countedId)
        this.countedFinished.resolve();
    },
    store: null,
  });
  public readonly transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => "duplicate-id-regression-session",
    });

  public constructor(
    admission: HttpRequestIdAdmission = new HttpRequestIdAdmission(),
    deferPing: boolean = true,
  ) {
    this.admission = admission;
    this.application.server.onerror = (): void => {
      this.protocolErrors += 1;
    };
    this.application.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (
        _request: unknown,
        extra: { readonly signal: AbortSignal },
      ): Promise<ReadResourceResult> => {
        const reservation: MaterializationReservation = reserveMaterializationBytes(COUNTED_BYTES);
        this.countedStarted = true;
        this.countedSignal = extra.signal;
        this.countedEntered.resolve();
        try {
          await this.countedRelease.promise;
          reservation.settle(COUNTED_BYTES);
          return COUNTED_RESULT;
        } catch (error: unknown) {
          reservation.fail();
          throw error;
        } finally {
          this.countedHandlerReturned = true;
        }
      },
    );
    if (deferPing)
      this.application.server.setRequestHandler(
        PingRequestSchema,
        async (): Promise<EmptyResult> => {
          this.cheapStarted = true;
          this.cheapEntered.resolve();
          await this.cheapRelease.promise;
          this.cheapHandlerFinished = true;
          return {};
        },
      );
    const send: WebStandardStreamableHTTPServerTransport["send"] = this.transport.send.bind(
      this.transport,
    );
    this.transport.send = async (message: JSONRPCMessage, options?: SendOptions): Promise<void> => {
      const counted: boolean =
        isJSONRPCResultResponse(message) &&
        ReadResourceResultSchema.safeParse(message.result).success;
      if (counted) {
        this.countedSendStarted = true;
        this.bytesAtCountedSend = this.budget.reservedBytes;
        this.sendEntered.resolve();
        if (this.holdCountedSend) await this.sendRelease.promise;
      }
      // Observe the installed SDK's real mapping/write/cleanup behavior, not a fake transport.
      await send(message, options);
      if (counted) this.countedSendSucceeded = true;
    };
  }

  public async dispatch(body: unknown, label: string = "other"): Promise<Response> {
    const scope: MaterializationScope = new MaterializationScope(this.budget);
    try {
      // Same public composition as HttpMaterializationBudget, with a tiny observable counter.
      const response: Response = await withMaterializationScope(
        scope,
        async (): Promise<Response> =>
          await this.admission.handle(
            this.transport,
            new Request("http://127.0.0.1/mcp", {
              method: "POST",
              headers: requestHeaders(this.transport.sessionId ?? null),
              body: JSON.stringify(body),
            }),
            body,
          ),
      );
      const tracked: Response = responseWithFinish(response, (): void => {
        this.finishedResponses.add(label);
        scope.finishResponse();
      });
      this.responses.push(tracked);
      return tracked;
    } catch (error: unknown) {
      scope.finishResponse();
      throw error;
    }
  }

  public async initialize(): Promise<void> {
    await this.application.server.connect(this.transport);
    await responsePayload(await this.dispatch(initializeRequest(1), "initialize"));
    const send: WebStandardStreamableHTTPServerTransport["send"] = this.transport.send.bind(
      this.transport,
    );
    this.transport.send = async (message: JSONRPCMessage, options?: SendOptions): Promise<void> => {
      const counted: boolean =
        isJSONRPCResultResponse(message) &&
        ReadResourceResultSchema.safeParse(message.result).success;
      const cheap: boolean =
        isJSONRPCResultResponse(message) && !counted && message.id === this.cheapId;
      try {
        await send(message, options);
      } finally {
        // Signal after the admission wrapper's actual send finally, not its inner SDK call.
        if (counted) this.countedSent.resolve();
        if (cheap) this.cheapSent.resolve();
      }
    };
  }

  public async counted(id: RequestId): Promise<Response> {
    this.countedId = id;
    return await this.dispatch(
      { jsonrpc: "2.0", id, method: "resources/read", params: { uri: COUNTED_URI } },
      "A",
    );
  }

  public async cheap(id: RequestId): Promise<Response> {
    this.cheapId = id;
    return await this.dispatch({ jsonrpc: "2.0", id, method: "ping" }, "B");
  }

  public async notification(): Promise<Response> {
    return await this.dispatch(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "notification",
    );
  }

  public async cancel(id: RequestId): Promise<Response> {
    return await this.dispatch(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } },
      "cancel",
    );
  }

  public cancelBeforeHandler(id: RequestId): void {
    const onmessage: WebStandardStreamableHTTPServerTransport["onmessage"] =
      this.transport.onmessage;
    if (onmessage === undefined) throw new Error("Expected connected SDK transport");
    let pending: boolean = true;
    this.transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo): void => {
      onmessage(message, extra);
      if (pending && isJSONRPCRequest(message) && message.id === id) {
        pending = false;
        onmessage(
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } },
          extra,
        );
      }
    };
  }

  public async close(): Promise<void> {
    this.countedRelease.resolve();
    this.cheapRelease.resolve();
    this.sendRelease.resolve();
    if (this.countedStarted) {
      await this.countedFinished.promise;
      if (this.countedSignal === null || !this.countedSignal.aborted || this.countedSendStarted)
        await this.countedSent.promise;
    }
    if (this.cheapStarted) await this.cheapSent.promise;
    for (const response of this.responses) {
      if (response.body !== null && !response.bodyUsed) await response.body.cancel();
    }
    await this.application.close();
  }
}
