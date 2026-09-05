import { expect, test } from "bun:test";
import {
  type EmptyResult,
  EmptyResultSchema,
  JSONRPCErrorResponseSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  HttpRequestIdAdmission,
  MAX_SESSION_REQUEST_IDS,
  MAX_TRACKED_REQUEST_IDS,
} from "../src/http/request-id-admission.js";
import { installProcessingAdmission } from "../src/mcp/request-processing-admission.js";
import {
  RequestIdClaim,
  startRequestIdHandler,
  withRequestIdClaim,
} from "../src/request-id-admission.js";
import { DuplicateIdFixture } from "./support/duplicate-inflight-request-id-fixture.js";
import { initializeRequest, requestHeaders, responsePayload } from "./support/http-mcp-harness.js";

test("claim joins handler, response and send; an abort cannot end an already-started send", (): void => {
  let releases: number = 0;
  const claim: RequestIdClaim = new RequestIdClaim(7, (): void => {
    releases += 1;
  });
  const controller: AbortController = new AbortController();
  claim.markDispatched();
  const finishHandler: () => void = withRequestIdClaim(claim, (): (() => void) =>
    startRequestIdHandler(7, controller.signal),
  );
  claim.finishDispatch();
  claim.finishResponse();
  finishHandler();
  expect(releases).toBe(0);
  const finishSend: () => void = claim.startSend();
  controller.abort();
  expect(releases).toBe(0);
  finishSend();
  finishSend();
  finishHandler();
  claim.finishResponse();
  expect(releases).toBe(1);
  expect((): (() => void) => claim.startSend()).toThrow();
  expect((): (() => void) => claim.startHandler(controller.signal)).toThrow();
});

test("pre-send cancellation and rejected dispatch release only after their remaining owners finish", (): void => {
  for (const abortFirst of [false, true]) {
    let releases: number = 0;
    const claim: RequestIdClaim = new RequestIdClaim("7", (): void => {
      releases += 1;
    });
    const controller: AbortController = new AbortController();
    claim.markDispatched();
    if (abortFirst) controller.abort();
    const finish: () => void = claim.startHandler(controller.signal);
    expect((): (() => void) => claim.startHandler(controller.signal)).toThrow();
    claim.finishResponse();
    if (!abortFirst) controller.abort();
    expect(releases).toBe(0);
    finish();
    expect(releases).toBe(1);
  }
  let releases: number = 0;
  const rejected: RequestIdClaim = new RequestIdClaim(0, (): void => {
    releases += 1;
  });
  rejected.finishResponse();
  expect(releases).toBe(0);
  rejected.finishDispatch();
  expect(releases).toBe(1);
  startRequestIdHandler(0, new AbortController().signal)();
  const mismatch: RequestIdClaim = new RequestIdClaim(1, (): void => {});
  expect((): (() => void) =>
    withRequestIdClaim(mismatch, (): (() => void) =>
      startRequestIdHandler("1", new AbortController().signal),
    ),
  ).toThrow();
});

test("a monotonic abort after handler completion closes the no-send branch", (): void => {
  let releases: number = 0;
  const claim: RequestIdClaim = new RequestIdClaim(7, (): void => {
    releases += 1;
  });
  const controller: AbortController = new AbortController();
  claim.markDispatched();
  const finish: () => void = claim.startHandler(controller.signal);
  finish();
  claim.finishDispatch();
  claim.finishResponse();
  expect(releases).toBe(0);
  controller.abort();
  expect(releases).toBe(1);
  expect((): (() => void) => claim.startSend()).toThrow();
});

test("oversized request IDs are rejected without reflection; the exact bound and invalid numbers are checked", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    const oversized: string = `private-request-marker${"x".repeat(1024)}`;
    const rejected: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: oversized,
      method: "ping",
    });
    expect(rejected.status).toBe(400);
    const text: string = await rejected.text();
    expect(text).not.toContain("private-request-marker");
    const parsed: { readonly id: null; readonly error: { readonly message: string } } = z
      .object({ id: z.null(), error: z.object({ message: z.string() }) })
      .parse(JSON.parse(text));
    expect(parsed.id).toBeNull();
    expect(parsed.error.message).toBe("MCP request ID exceeds 1024 UTF-16 units.");
    const maximum: string = "\u0001".repeat(1024);
    const accepted: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: maximum,
      method: "ping",
    });
    const acceptedText: string = await accepted.text();
    expect(acceptedText).toContain("\\u0001");
    expect(Buffer.byteLength(acceptedText)).toBeLessThan(8192);
    const invalid: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: Number.NaN,
      method: "ping",
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("all HTTP batch shapes reject atomically without creating ID claims", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    const duplicate: Response = await fixture.dispatch([
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", id: 7, method: "ping" },
    ]);
    expect(duplicate.status).toBe(400);
    await duplicate.text();
    expect(fixture.admission.activeClaims).toBe(0);
    const valid: Response = await fixture.dispatch([
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", id: "7", method: "ping" },
    ]);
    expect(valid.status).toBe(400);
    await valid.text();
    expect(fixture.admission.activeClaims).toBe(0);
    const malformed: Response = await fixture.dispatch([
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", id: null, method: "ping" },
    ]);
    expect(malformed.status).toBe(400);
    await malformed.text();
    expect(fixture.admission.activeClaims).toBe(0);
    const oversized: Response = await fixture.dispatch(
      Array.from(
        { length: MAX_SESSION_REQUEST_IDS + 1 },
        (_unused: unknown, id: number): Record<string, unknown> => ({
          jsonrpc: "2.0",
          id,
          method: "ping",
        }),
      ),
    );
    expect(oversized.status).toBe(400);
    await oversized.text();
    expect(fixture.admission.activeClaims).toBe(0);
    for (const body of [
      [],
      [{ jsonrpc: "2.0", method: "notifications/initialized" }],
      [{ jsonrpc: "2.0", id: 7, result: {} }],
    ]) {
      const rejected: Response = await fixture.dispatch(body);
      expect(rejected.status).toBe(400);
      await rejected.text();
      expect(fixture.admission.activeClaims).toBe(0);
    }
  } finally {
    await fixture.close();
  }
});

test("built-in initialize and ping handlers use processing admission and release rejected claims", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.application.server.connect(fixture.transport);
    installProcessingAdmission(fixture.application.server, (): null => null);
    const initialize: Response = await fixture.dispatch(initializeRequest(1));
    expect(await responsePayload(initialize)).toMatchObject({ id: 1, error: { code: -32003 } });
    expect(fixture.admission.activeClaims).toBe(0);
    const ping: Response = await fixture.dispatch({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(await responsePayload(ping)).toMatchObject({ id: 7, error: { code: -32003 } });
    expect(fixture.admission.activeClaims).toBe(0);
    installProcessingAdmission(fixture.application.server, (): (() => void) => (): void => {});
    expect(
      await responsePayload(await fixture.dispatch({ jsonrpc: "2.0", id: 7, method: "ping" })),
    ).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("SDK failures and preflight rejection before wrapped handlers run do not retain claims", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    const unknownMethod: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "missing/method",
    });
    const error: ReturnType<typeof JSONRPCErrorResponseSchema.parse> =
      JSONRPCErrorResponseSchema.parse(await responsePayload(unknownMethod));
    expect(error.id).toBe(7);
    expect(fixture.admission.activeClaims).toBe(0);
    const requests: readonly Record<string, unknown>[] = [
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} },
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { task: { ttl: 1 } } },
      { jsonrpc: "2.0", id: 7, method: "initialize", params: {} },
    ];
    for (const request of requests) {
      const response: Response = await fixture.dispatch(request);
      expect(response.status).toBe(400);
      expect(await responsePayload(response)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP request parameters are invalid or unsupported." },
      });
      expect(fixture.admission.activeClaims).toBe(0);
    }
    const invalid: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
      params: [],
    });
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("cancellation before SDK schema or task rejection does not strand an ID claim", async (): Promise<void> => {
  const requests: readonly Record<string, unknown>[] = [
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} },
    { jsonrpc: "2.0", id: 7, method: "tools/list", params: { task: { ttl: 1 } } },
  ];
  for (const request of requests) {
    const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
    try {
      await fixture.initialize();
      fixture.cancelBeforeHandler(7);
      const response: Response = await fixture.dispatch(request);
      expect(response.status).toBe(400);
      if (response.body === null) throw new Error("Expected canceled request response");
      await response.body.cancel();
      // Await a subsequent real SDK handler/send rather than guessing at microtask timing.
      await responsePayload(await fixture.dispatch({ jsonrpc: "2.0", id: 8, method: "ping" }));
      expect(fixture.admission.activeClaims).toBe(0);
    } finally {
      await fixture.close();
    }
  }
});

test("outgoing requests, client responses and notifications cannot settle an incoming claim", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    const counted: Response = await fixture.counted(0);
    await fixture.countedEntered.promise;
    const outbound: Promise<EmptyResult> = fixture.application.server.request(
      { method: "ping" },
      EmptyResultSchema,
    );
    expect(fixture.admission.activeClaims).toBe(1);
    const reply: Response = await fixture.dispatch({ jsonrpc: "2.0", id: 0, result: {} });
    expect(reply.status).toBe(202);
    await reply.text();
    expect(await outbound).toEqual({});
    expect(fixture.admission.activeClaims).toBe(1);
    const notification: Response = await fixture.notification();
    expect(notification.status).toBe(202);
    await notification.text();
    expect(fixture.admission.activeClaims).toBe(1);
    if (counted.body === null) throw new Error("Expected counted SSE body");
    await counted.body.cancel();
    fixture.countedRelease.resolve();
    await fixture.countedSent.promise;
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("session and global claim ceilings reject promptly, preserve session independence and recover", async (): Promise<void> => {
  const admission: HttpRequestIdAdmission = new HttpRequestIdAdmission();
  const fixtures: DuplicateIdFixture[] = [];
  const retained: Response[] = [];
  try {
    for (let index: number = 0; index < 5; index += 1) {
      const fixture: DuplicateIdFixture = new DuplicateIdFixture(admission, false);
      fixtures.push(fixture);
      await fixture.initialize();
    }
    for (const fixture of fixtures.slice(0, 4)) {
      for (let id: number = 0; id < MAX_SESSION_REQUEST_IDS; id += 1) {
        const response: Response = await fixture.dispatch({ jsonrpc: "2.0", id, method: "ping" });
        expect(response.status).toBe(200);
        retained.push(response);
      }
      const denied: Response = await fixture.dispatch({
        jsonrpc: "2.0",
        id: "extra",
        method: "ping",
      });
      expect(denied.status).toBe(503);
      expect(denied.headers.get("retry-after")).toBe("1");
      await denied.text();
    }
    expect(admission.activeClaims).toBe(MAX_TRACKED_REQUEST_IDS);
    const other: DuplicateIdFixture | undefined = fixtures.at(-1);
    const first: Response | undefined = retained[0];
    if (other === undefined || first === undefined) throw new Error("Expected admission fixtures");
    const denied: Response = await other.dispatch({ jsonrpc: "2.0", id: 0, method: "ping" });
    expect(denied.status).toBe(503);
    expect(await responsePayload(denied)).toMatchObject({
      id: null,
      error: { code: -32003, data: { retryable: true } },
    });
    await first.text();
    expect(admission.activeClaims).toBe(MAX_TRACKED_REQUEST_IDS - 1);
    expect(
      await responsePayload(await other.dispatch({ jsonrpc: "2.0", id: 0, method: "ping" })),
    ).toEqual({ jsonrpc: "2.0", id: 0, result: {} });
  } finally {
    for (const fixture of fixtures) await fixture.close();
  }
  expect(admission.activeClaims).toBe(0);
});

test("non-POST session requests pass through without creating ID claims", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    const missing: Response = await fixture.admission.handle(
      fixture.transport,
      new Request("http://127.0.0.1/mcp", { method: "POST" }),
    );
    expect(missing.status).toBe(400);
    await missing.text();
    const stream: Response = await fixture.admission.handle(
      fixture.transport,
      new Request("http://127.0.0.1/mcp", {
        headers: requestHeaders(fixture.transport.sessionId ?? null),
      }),
    );
    expect(stream.status).toBe(200);
    if (stream.body !== null) await stream.body.cancel();
    const closed: Response = await fixture.admission.handle(
      fixture.transport,
      new Request("http://127.0.0.1/mcp", {
        method: "DELETE",
        headers: requestHeaders(fixture.transport.sessionId ?? null),
      }),
    );
    expect(closed.status).toBe(200);
    await closed.text();
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("failed SDK dispatch releases unstarted claims and supports immediate reuse", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    const handle: typeof fixture.transport.handleRequest = fixture.transport.handleRequest.bind(
      fixture.transport,
    );
    fixture.transport.handleRequest = async (): Promise<Response> => {
      throw new Error("fixture dispatch failure");
    };
    await expect(fixture.dispatch({ jsonrpc: "2.0", id: 7, method: "ping" })).rejects.toThrow(
      "fixture dispatch failure",
    );
    expect(fixture.admission.activeClaims).toBe(0);
    fixture.transport.handleRequest = handle;
    expect(
      await responsePayload(await fixture.dispatch({ jsonrpc: "2.0", id: 7, method: "ping" })),
    ).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a response from outside the owning handler context cannot settle another request", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    const response: Response = await fixture.counted(7);
    await fixture.countedEntered.promise;
    await expect(fixture.transport.send({ jsonrpc: "2.0", id: 7, result: {} })).rejects.toThrow(
      "Invalid MCP request-ID response ownership",
    );
    const unrelated: RequestIdClaim = new RequestIdClaim(7, (): void => {});
    await expect(
      withRequestIdClaim(
        unrelated,
        async (): Promise<void> =>
          await fixture.transport.send({ jsonrpc: "2.0", id: 7, result: {} }),
      ),
    ).rejects.toThrow("Invalid MCP request-ID response ownership");
    expect(fixture.admission.activeClaims).toBe(1);
    if (response.body === null) throw new Error("Expected counted SSE body");
    await response.body.cancel();
    fixture.countedRelease.resolve();
    await fixture.countedSent.promise;
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("removing a handler removes its preflight schema without changing unknown-method errors", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture(new HttpRequestIdAdmission(), false);
  try {
    await fixture.initialize();
    fixture.application.server.removeRequestHandler("resources/read");
    const response: Response = await fixture.dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: {},
    });
    expect(response.status).toBe(200);
    expect(await responsePayload(response)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    expect(fixture.admission.activeClaims).toBe(0);
    installProcessingAdmission(fixture.application.server, undefined);
    expect(
      await responsePayload(await fixture.dispatch({ jsonrpc: "2.0", id: 7, method: "ping" })),
    ).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(fixture.admission.activeClaims).toBe(0);
  } finally {
    await fixture.close();
  }
});
