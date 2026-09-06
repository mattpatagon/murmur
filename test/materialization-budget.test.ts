import { expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  HTTP_MATERIALIZATION_BYTES,
  HttpMaterializationBudget,
} from "../src/http/http-materialization-budget.js";
import {
  MaterializationByteBudget,
  MaterializationCapacityError,
  type MaterializationReservation,
  MaterializationScope,
  reserveMaterializationBytes,
  reserveTemporaryMaterializationBytes,
  startMaterializationHandler,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { initializeRequest, requestHeaders, responsePayload } from "./support/http-mcp-harness.js";

type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };

test("byte reservations validate bounds, prevent overflow, and shrink without growing", (): void => {
  for (const invalid of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect((): MaterializationByteBudget => new MaterializationByteBudget(invalid)).toThrow();
    expect((): MaterializationReservation => reserveMaterializationBytes(invalid)).toThrow();
    expect((): (() => void) => reserveTemporaryMaterializationBytes(invalid)).toThrow();
  }
  expect((): MaterializationByteBudget => new MaterializationByteBudget(0)).toThrow();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(Number.MAX_SAFE_INTEGER);
  const reservation: ReturnType<MaterializationByteBudget["reserve"]> = budget.reserve(
    Number.MAX_SAFE_INTEGER,
  );
  expect((): ReturnType<MaterializationByteBudget["reserve"]> => budget.reserve(1)).toThrow(
    MaterializationCapacityError,
  );
  expect(budget.reservedBytes).toBe(Number.MAX_SAFE_INTEGER);
  reservation.resize(5);
  expect(budget.reservedBytes).toBe(5);
  expect((): void => reservation.resize(6)).toThrow();
  expect((): void => reservation.resize(-1)).toThrow();
  expect(budget.reservedBytes).toBe(5);
  reservation.release();
  reservation.release();
  expect(budget.reservedBytes).toBe(0);
});

test("retained bytes join handler and response lifetimes in either completion order", (): void => {
  for (const responseFirst of [true, false]) {
    const budget: MaterializationByteBudget = new MaterializationByteBudget(32);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const finishHandler: () => void = scope.startHandler();
    const reservation: MaterializationReservation = scope.reserve(8);
    reservation.settle(3);
    reservation.settle(3);
    reservation.fail();
    expect(budget.reservedBytes).toBe(3);
    if (responseFirst) scope.finishResponse();
    else finishHandler();
    expect(budget.reservedBytes).toBe(3);
    if (responseFirst) finishHandler();
    else scope.finishResponse();
    finishHandler();
    scope.finishResponse();
    expect(budget.reservedBytes).toBe(0);
    expect((): (() => void) => scope.startHandler()).toThrow(MaterializationCapacityError);
    expect((): MaterializationReservation => scope.reserve(1)).toThrow(
      MaterializationCapacityError,
    );
    expect((): (() => void) => scope.reserveTemporary(1)).toThrow(MaterializationCapacityError);
  }
});

test("pending queries survive abandoned outer work while empty polls and failed queries release immediately", (): void => {
  const budget: MaterializationByteBudget = new MaterializationByteBudget(32);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const finishHandler: () => void = scope.startHandler();
  for (let poll: number = 0; poll < 20; poll += 1) {
    const empty: MaterializationReservation = scope.reserve(8);
    expect(budget.reservedBytes).toBe(8);
    empty.settle(0);
    expect(budget.reservedBytes).toBe(0);
  }
  const failed: MaterializationReservation = scope.reserve(8);
  expect((): void => failed.settle(9)).toThrow();
  expect(budget.reservedBytes).toBe(8);
  failed.fail();
  failed.fail();
  expect(budget.reservedBytes).toBe(0);
  const pending: MaterializationReservation = scope.reserve(8);
  finishHandler();
  scope.finishResponse();
  expect(budget.reservedBytes).toBe(8);
  pending.settle(4);
  expect(budget.reservedBytes).toBe(0);
});

test("ALS scopes share a byte budget, preserve async context, and keep temporary bytes separate", async (): Promise<void> => {
  const budget: MaterializationByteBudget = new MaterializationByteBudget(32);
  const first: MaterializationScope = new MaterializationScope(budget);
  const second: MaterializationScope = new MaterializationScope(budget);
  const finishFirst: () => void = first.startHandler();
  const finishSecond: () => void = second.startHandler();
  await withMaterializationScope(first, async (): Promise<void> => {
    await Promise.resolve();
    const reservation: MaterializationReservation = reserveMaterializationBytes(24);
    reservation.settle(4);
  });
  let releaseTemporary: () => void = (): void => {};
  withMaterializationScope(second, (): void => {
    releaseTemporary = reserveTemporaryMaterializationBytes(28);
    expect((): MaterializationReservation => reserveMaterializationBytes(1)).toThrow(
      MaterializationCapacityError,
    );
  });
  finishSecond();
  second.finishResponse();
  expect(budget.reservedBytes).toBe(32);
  releaseTemporary();
  releaseTemporary();
  expect(budget.reservedBytes).toBe(4);
  finishFirst();
  first.finishResponse();
  expect(budget.reservedBytes).toBe(0);
  const unbounded: MaterializationReservation = reserveMaterializationBytes(8);
  unbounded.settle(8);
  unbounded.fail();
  expect((): void => unbounded.settle(9)).toThrow();
  startMaterializationHandler()();
  reserveTemporaryMaterializationBytes(8)();
});

test("HTTP policy cleans up failed dispatch, bodyless responses, and unread response cancellation", async (): Promise<void> => {
  const http: HttpMaterializationBudget = new HttpMaterializationBudget();
  await expect(
    http.handle(async (): Promise<Response> => {
      const reservation: MaterializationReservation = reserveMaterializationBytes(
        HTTP_MATERIALIZATION_BYTES,
      );
      reservation.settle(1);
      throw new Error("Fixed injected dispatch failure");
    }),
  ).rejects.toThrow("Fixed injected dispatch failure");
  const bodyless: Response = await http.handle(async (): Promise<Response> => {
    const reservation: MaterializationReservation = reserveMaterializationBytes(
      HTTP_MATERIALIZATION_BYTES,
    );
    reservation.settle(1);
    return new Response(null, { status: 204 });
  });
  expect(bodyless.status).toBe(204);
  const held: Response = await http.handle(async (): Promise<Response> => {
    const finish: () => void = startMaterializationHandler();
    try {
      reserveMaterializationBytes(HTTP_MATERIALIZATION_BYTES).settle(HTTP_MATERIALIZATION_BYTES);
      return new Response("held");
    } finally {
      finish();
    }
  });
  await expect(
    http.handle(async (): Promise<Response> => {
      reserveMaterializationBytes(1);
      return new Response(null);
    }),
  ).rejects.toBeInstanceOf(MaterializationCapacityError);
  if (held.body === null) throw new Error("Expected held response body");
  await held.body.cancel();
  const recovered: Response = await http.handle(async (): Promise<Response> => {
    reserveMaterializationBytes(HTTP_MATERIALIZATION_BYTES).settle(0);
    return new Response("recovered");
  });
  expect(await recovered.text()).toBe("recovered");
});

type Session = {
  readonly application: MurmurApplication;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly id: string;
};

async function post(
  http: HttpMaterializationBudget,
  session: Session,
  body: Record<string, unknown>,
): Promise<Response> {
  return await http.handle(
    async (): Promise<Response> =>
      await session.transport.handleRequest(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: requestHeaders(session.id),
          body: JSON.stringify(body),
        }),
      ),
  );
}

async function session(http: HttpMaterializationBudget): Promise<Session> {
  const application: MurmurApplication = new MurmurApplication({
    branchName: null,
    client: null,
    repositoryName: null,
    reserveProcessingCapacity: (): (() => void) => (): void => {},
    store: null,
  });
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => crypto.randomUUID(),
    });
  await application.server.connect(transport);
  const response: Response = await http.handle(
    async (): Promise<Response> =>
      await transport.handleRequest(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: requestHeaders(),
          body: JSON.stringify(initializeRequest(1)),
        }),
      ),
  );
  await responsePayload(response);
  const id: string | undefined = transport.sessionId;
  if (id === undefined) throw new Error("Initialized SDK session is missing");
  return { application, transport, id };
}

function readRequest(id: string | number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "resources/read", params: { uri: "murmur://inbox/probe" } };
}

test("SDK cancellation, session close, and unread results cannot churn the shared retained-byte budget", async (): Promise<void> => {
  const http: HttpMaterializationBudget = new HttpMaterializationBudget();
  const first: Session = await session(http);
  const second: Session = await session(http);
  const entered: Gate = Promise.withResolvers<void>();
  const released: Gate = Promise.withResolvers<void>();
  const completed: Gate = Promise.withResolvers<void>();
  const responses: Response[] = [];
  let starts: number = 0;
  for (const current of [first, second]) {
    current.application.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (): Promise<ReadResourceResult> => {
        const reservation: MaterializationReservation = reserveMaterializationBytes(
          HTTP_MATERIALIZATION_BYTES,
        );
        starts += 1;
        try {
          if (starts === 1) {
            entered.resolve();
            await released.promise;
          }
          reservation.settle(HTTP_MATERIALIZATION_BYTES);
          return { contents: [] };
        } catch (error: unknown) {
          reservation.fail();
          throw error;
        } finally {
          completed.resolve();
        }
      },
    );
  }
  try {
    const abandoned: Response = await post(http, first, readRequest(7));
    responses.push(abandoned);
    await entered.promise;
    if (abandoned.body === null) throw new Error("Expected streaming SDK response");
    await abandoned.body.cancel();
    const canceled: Response = await post(http, first, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });
    expect(canceled.status).toBe(202);
    const closed: Response = await http.handle(
      async (): Promise<Response> =>
        await first.transport.handleRequest(
          new Request("http://127.0.0.1/mcp", {
            method: "DELETE",
            headers: requestHeaders(first.id),
          }),
        ),
    );
    expect(closed.status).toBe(200);
    await closed.text();
    const denied: Response = await post(http, second, readRequest("7"));
    expect(await responsePayload(denied)).toMatchObject({
      id: "7",
      error: { code: -32003, data: { retryable: true, retry_after_ms: 1000 } },
    });
    expect(starts).toBe(1);
    const small: Response = await post(http, second, {
      id: 8,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    expect(await responsePayload(small)).toMatchObject({
      id: 8,
      result: { tools: expect.any(Array) },
    });
    released.resolve();
    await completed.promise;
    const retained: Response = await post(http, second, readRequest("7"));
    responses.push(retained);
    const blocked: Response = await post(http, second, readRequest(7));
    expect(await responsePayload(blocked)).toMatchObject({ id: 7, error: { code: -32003 } });
    expect(await responsePayload(retained)).toEqual({
      jsonrpc: "2.0",
      id: "7",
      result: { contents: [] },
    });
    const recovered: Response = await post(http, second, readRequest(7));
    expect(await responsePayload(recovered)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { contents: [] },
    });
    expect(starts).toBe(3);
  } finally {
    released.resolve();
    for (const response of responses) {
      if (response.body !== null && !response.bodyUsed) await response.body.cancel();
    }
    await first.application.close();
    await second.application.close();
  }
});
