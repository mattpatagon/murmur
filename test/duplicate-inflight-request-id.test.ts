import { expect, test } from "bun:test";

import {
  COUNTED_BYTES,
  COUNTED_RESULT,
  DuplicateIdFixture,
  type RequestId,
} from "./support/duplicate-inflight-request-id-fixture.js";
import { responsePayload } from "./support/http-mcp-harness.js";

const DUPLICATE_IDS: readonly RequestId[] = [42, "42"];
for (const id of DUPLICATE_IDS) {
  test(`duplicate in-flight ${typeof id} IDs cannot move counted bytes to an uncharged HTTP response`, async (): Promise<void> => {
    const fixture: DuplicateIdFixture = new DuplicateIdFixture();
    try {
      await fixture.initialize();
      const original: Response = await fixture.counted(id);
      await fixture.countedEntered.promise;
      expect(fixture.budget.reservedBytes).toBe(COUNTED_BYTES);
      if (original.body === null) throw new Error("Expected the original SSE body");
      await original.body.cancel();
      expect(fixture.finishedResponses.has("A")).toBe(true);
      expect(fixture.budget.reservedBytes).toBe(COUNTED_BYTES);

      const successor: Response = await fixture.cheap(id);
      expect(successor.status).toBe(409);
      expect(await responsePayload(successor)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP request ID is already active." },
      });
      expect(fixture.cheapHandlerFinished).toBe(false);
      expect(fixture.admission.activeClaims).toBe(1);
      fixture.countedRelease.resolve();
      await fixture.countedSent.promise;
      expect(fixture.countedSendSucceeded).toBe(false);
      expect(fixture.budget.reservedBytes).toBe(0);
      expect(fixture.admission.activeClaims).toBe(0);
      fixture.cheapRelease.resolve();
      expect(await responsePayload(await fixture.cheap(id))).toEqual({
        jsonrpc: "2.0",
        id,
        result: {},
      });
      expect(fixture.admission.activeClaims).toBe(0);
    } finally {
      await fixture.close();
    }
  });
}

test("numeric and string IDs remain distinct and notifications do not replace request routing", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    const original: Response = await fixture.counted(42);
    await fixture.countedEntered.promise;
    if (original.body === null) throw new Error("Expected the original SSE body");
    await original.body.cancel();
    const other: Response = await fixture.cheap("42");
    await fixture.cheapEntered.promise;
    const notification: Response = await fixture.notification();
    expect(notification.status).toBe(202);
    await notification.text();
    fixture.countedRelease.resolve();
    await fixture.countedSent.promise;
    expect(fixture.countedSendSucceeded).toBe(false);
    expect(fixture.budget.reservedBytes).toBe(0);
    expect(fixture.finishedResponses.has("B")).toBe(false);
    expect(fixture.cheapHandlerFinished).toBe(false);
    fixture.cheapRelease.resolve();
    expect(await responsePayload(other)).toEqual({ jsonrpc: "2.0", id: "42", result: {} });
    await fixture.cheapSent.promise;
    expect(fixture.cheapHandlerFinished).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("a completed send retains the ID until the original response is consumed", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    const response: Response = await fixture.counted(42);
    await fixture.countedEntered.promise;
    fixture.countedRelease.resolve();
    await fixture.countedSent.promise;
    expect(fixture.admission.activeClaims).toBe(1);
    const duplicate: Response = await fixture.cheap(42);
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    expect(await responsePayload(response)).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: COUNTED_RESULT,
    });
    expect(fixture.admission.activeClaims).toBe(0);
    fixture.cheapRelease.resolve();
    expect(await responsePayload(await fixture.cheap(42))).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {},
    });
  } finally {
    await fixture.close();
  }
});

test("cancellation before handler start retains queued work then retires the affected session", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    fixture.cancelBeforeHandler(42);
    const response: Response = await fixture.counted(42);
    await fixture.countedEntered.promise;
    if (fixture.countedSignal === null || response.body === null)
      throw new Error("Expected counted handler and SSE body");
    expect(fixture.countedSignal.aborted).toBe(true);
    await response.body.cancel();
    const duplicate: Response = await fixture.cheap(42);
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    expect(fixture.admission.activeClaims).toBe(1);
    fixture.countedRelease.resolve();
    await fixture.countedFinished.promise;
    expect(fixture.bytesAtCountedSend).toBeNull();
    expect(fixture.admission.activeClaims).toBe(0);
    expect(fixture.budget.reservedBytes).toBe(0);
    const retired: Response = await fixture.cheap(42);
    expect(retired.status).toBe(404);
    await retired.text();
    const replacement: DuplicateIdFixture = new DuplicateIdFixture(fixture.admission, false);
    try {
      await replacement.initialize();
      expect(await responsePayload(await replacement.cheap(42))).toEqual({
        jsonrpc: "2.0",
        id: 42,
        result: {},
      });
      expect(fixture.admission.activeClaims).toBe(0);
    } finally {
      await replacement.close();
    }
  } finally {
    await fixture.close();
  }
});

test("an abort after send begins cannot release the ID while the actual send is pending", async (): Promise<void> => {
  const fixture: DuplicateIdFixture = new DuplicateIdFixture();
  try {
    await fixture.initialize();
    fixture.holdCountedSend = true;
    const response: Response = await fixture.counted(42);
    await fixture.countedEntered.promise;
    fixture.countedRelease.resolve();
    await fixture.sendEntered.promise;
    if (response.body === null) throw new Error("Expected SSE body");
    await response.body.cancel();
    const cancellation: Response = await fixture.cancel(42);
    expect(cancellation.status).toBe(202);
    await cancellation.text();
    if (fixture.countedSignal === null) throw new Error("Expected SDK request signal");
    expect(fixture.countedSignal.aborted).toBe(true);
    expect(fixture.admission.activeClaims).toBe(1);
    const duplicate: Response = await fixture.cheap(42);
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    fixture.sendRelease.resolve();
    await fixture.countedSent.promise;
    expect(fixture.admission.activeClaims).toBe(0);
    fixture.cheapRelease.resolve();
    expect(await responsePayload(await fixture.cheap(42))).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {},
    });
  } finally {
    await fixture.close();
  }
});
