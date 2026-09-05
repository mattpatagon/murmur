import { expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type JSONRPCMessage,
  PingRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { HttpRequestIdAdmission } from "../src/http/request-id-admission.js";
import { responseWithFinish } from "../src/http/response-lifecycle.js";
import {
  MaterializationByteBudget,
  type MaterializationReservation,
  MaterializationScope,
  reserveMaterializationBytes,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import {
  installProcessingAdmission,
  RequestProcessingServer,
} from "../src/mcp/request-processing-admission.js";
import {
  COUNTED_BYTES,
  COUNTED_RESULT,
  DuplicateIdFixture,
} from "./support/duplicate-inflight-request-id-fixture.js";
import { initializeRequest, requestHeaders, responsePayload } from "./support/http-mcp-harness.js";

test("pinned SDK retains a completed batch result after its sibling cancels and byte owners finish", async (): Promise<void> => {
  const server: RequestProcessingServer = new RequestProcessingServer(
    { name: "batch-retention-fixture", version: "1.0.0" },
    { capabilities: { resources: {} } },
  );
  installProcessingAdmission(server, (): (() => void) => (): void => {});
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => "batch-test",
    });
  const budget: MaterializationByteBudget = new MaterializationByteBudget(COUNTED_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const sent: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  const entered: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  const release: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers<void>();
  let response: Response | null = null;
  const sibling: { signal: AbortSignal | null } = { signal: null };
  server.setRequestHandler(ReadResourceRequestSchema, (): ReadResourceResult => {
    const reservation: MaterializationReservation = reserveMaterializationBytes(COUNTED_BYTES);
    reservation.settle(COUNTED_BYTES);
    return COUNTED_RESULT;
  });
  server.setRequestHandler(
    PingRequestSchema,
    async (
      _request: unknown,
      extra: { readonly signal: AbortSignal },
    ): Promise<Record<string, never>> => {
      sibling.signal = extra.signal;
      entered.resolve();
      await release.promise;
      return {};
    },
  );
  const send: typeof transport.send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage): Promise<void> => {
    await send(message);
    if ("id" in message && message.id === 11) sent.resolve();
  };
  const dispatch: (body: unknown) => Promise<Response> = async (body: unknown): Promise<Response> =>
    await transport.handleRequest(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: requestHeaders(transport.sessionId ?? null),
      }),
      { parsedBody: body },
    );
  try {
    await server.connect(transport);
    await responsePayload(await dispatch(initializeRequest(1)));
    response = responseWithFinish(
      await withMaterializationScope(
        scope,
        async (): Promise<Response> =>
          await dispatch([
            {
              jsonrpc: "2.0",
              id: 11,
              method: "resources/read",
              params: { uri: "murmur://inbox/test" },
            },
            { jsonrpc: "2.0", id: 12, method: "ping" },
          ]),
      ),
      (): void => scope.finishResponse(),
    );
    await Promise.all([sent.promise, entered.promise]);
    const cancellation: Response = await dispatch({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 12 },
    });
    expect(cancellation.status).toBe(202);
    await cancellation.text();
    if (sibling.signal === null || response.body === null) throw new Error("Expected live batch");
    expect(sibling.signal.aborted).toBe(true);
    await response.body.cancel();
    release.resolve();
    // A later SDK round trip drains the completed handlers without timing guesses.
    await responsePayload(await dispatch({ jsonrpc: "2.0", id: 13, method: "ping" }));
    expect(budget.reservedBytes).toBe(0);
    // Read-only, pinned-SDK diagnostic; production cleanup never touches private SDK state.
    const retained: Map<string | number, unknown> = z
      .map(z.union([z.string(), z.number()]), z.unknown())
      .parse(Reflect.get(transport, "_requestResponseMap"));
    expect(retained.has(11)).toBe(true);
    expect(retained.has(12)).toBe(false);
  } finally {
    release.resolve();
    if (response !== null && response.body !== null && !response.bodyUsed)
      await response.body.cancel();
    await server.close();
  }
});

test("HTTP batch rejection precedes SDK dispatch and creates no payload or ID owners", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    let dispatched: number = 0;
    const handle: typeof fixture.transport.handleRequest = fixture.transport.handleRequest.bind(
      fixture.transport,
    );
    fixture.transport.handleRequest = async (
      ...arguments_: Parameters<typeof handle>
    ): Promise<Response> => {
      dispatched += 1;
      return await handle(...arguments_);
    };
    const response: Response = await fixture.dispatch([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(response.status).toBe(400);
    expect(await responsePayload(response)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "MCP HTTP requests must contain one JSON-RPC message; batches are not supported.",
      },
    });
    expect(dispatched).toBe(0);
    expect(fixture.admission.activeClaims).toBe(0);
    expect(fixture.budget.reservedBytes).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("cancelled-before-send requests retire only their affected session after actual work ends", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  const other: DuplicateIdFixture = new DuplicateIdFixture(fixture.admission, false);
  let retired: number = 0;
  const close: typeof fixture.transport.close = fixture.transport.close.bind(fixture.transport);
  fixture.transport.close = async (): Promise<void> => {
    retired += 1;
    await close();
  };
  try {
    await fixture.initialize();
    await other.initialize();
    fixture.cancelBeforeHandler(42);
    const response: Response = await fixture.counted(42);
    await fixture.countedEntered.promise;
    if (response.body === null) throw new Error("Expected counted response");
    await response.body.cancel();
    expect(retired).toBe(0);
    fixture.countedRelease.resolve();
    await fixture.countedFinished.promise;
    expect(retired).toBe(1);
    expect(fixture.admission.activeClaims).toBe(0);
    expect(fixture.budget.reservedBytes).toBe(0);
    const rejected: Response = await fixture.cheap(42);
    expect(rejected.status).toBe(404);
    await rejected.text();
    expect(await responsePayload(await other.cheap(42))).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {},
    });
    expect(retired).toBe(1);
  } finally {
    await fixture.close();
    await other.close();
  }
});
