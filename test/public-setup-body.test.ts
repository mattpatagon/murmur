import { expect, test } from "bun:test";
import { PUBLIC_SETUP_PATH } from "../src/http/public-setup.js";
import { readPublicSetupBody } from "../src/http/public-setup-body.js";
import {
  PublicSetupTestTime,
  publicSetupHarness,
  type SetupHarness,
} from "./support/public-setup-harness.js";

function bodyRequest(body: BodyInit | null = "{}", headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${PUBLIC_SETUP_PATH}`, {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

test("public setup bounds declared and streamed bytes, rejects invalid UTF8 and requires valid JSON", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  expect(await readPublicSetupBody(bodyRequest(`{${" ".repeat(8190)}}`), 5000, time)).toEqual({});
  for (const request of [
    bodyRequest(null),
    bodyRequest("invalid json"),
    bodyRequest("{}", { "content-length": "8193" }),
    bodyRequest("{}", { "content-length": "not a length" }),
    bodyRequest("{}", { "content-length": "-1" }),
    bodyRequest(" ".repeat(8193)),
    bodyRequest(new Uint8Array([0xff])),
  ])
    await expect(readPublicSetupBody(request, 5000, time)).rejects.toThrow();
  expect(time.pending()).toBe(0);
});

test("public setup enforces one absolute body deadline and never waits for hostile cancellation", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  let cancelled: boolean = false;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    cancel: (): Promise<void> => {
      cancelled = true;
      return new Promise<void>((): void => undefined);
    },
  });
  const pending: Promise<unknown> = readPublicSetupBody(bodyRequest(body), 5000, time);
  expect(time.pending()).toBe(1);
  time.advance(5000);
  await expect(pending).rejects.toThrow("deadline");
  expect(cancelled).toBe(true);
  expect(time.pending()).toBe(0);
  expect(body.locked).toBe(false);
});

test("public setup aborts stalled uploads immediately and cleans up its deadline", async (): Promise<void> => {
  for (const alreadyAborted of [false, true]) {
    const time: PublicSetupTestTime = new PublicSetupTestTime();
    const controller: AbortController = new AbortController();
    let cancelled: boolean = false;
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      cancel: (): Promise<void> => {
        cancelled = true;
        return new Promise<void>((): void => undefined);
      },
    });
    if (alreadyAborted) controller.abort();
    const request: Request = new Request(`http://localhost${PUBLIC_SETUP_PATH}`, {
      body,
      method: "POST",
      signal: controller.signal,
    });
    const pending: Promise<unknown> = readPublicSetupBody(request, 5000, time);
    if (!alreadyAborted) controller.abort();
    await expect(pending).rejects.toThrow(/abort|cancel/u);
    expect(time.now()).toBe(0);
    expect(time.pending()).toBe(0);
    expect(cancelled).toBe(!alreadyAborted);
    expect(body.locked).toBe(false);
  }
});

test("empty chunks cannot reset the absolute upload deadline or change valid content", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  let pulls: number = 0;
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      pulls += 1;
      if (pulls < 100) {
        controller.enqueue(new Uint8Array());
        time.advance(1);
      } else {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      }
    },
  });
  expect(await readPublicSetupBody(bodyRequest(body), 5000, time)).toEqual({});
  expect(time.pending()).toBe(0);
  let latePulls: number = 0;
  const stalled: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      latePulls += 1;
      if (latePulls < 10) {
        controller.enqueue(new Uint8Array());
        time.advance(1000);
      } else {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      }
    },
  });
  await expect(readPublicSetupBody(bodyRequest(stalled), 5000, time)).rejects.toThrow(
    /deadline|interrupted/u,
  );
  expect(latePulls).toBeLessThan(10);
  expect(time.pending()).toBe(0);
});

test("body failures return a fixed client error and release public request capacity", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  try {
    const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>();
    const pending: Promise<Response> = fixture.handle(bodyRequest(body));
    expect(fixture.capacity.reservePublicRequest("another-public-request")).toBeNull();
    fixture.time.advance(5000);
    const failure: Response = await pending;
    expect(failure.status).toBe(400);
    expect(await failure.text()).toContain("8192 bytes");
    const available: (() => void) | null =
      fixture.capacity.reservePublicRequest("another-public-request");
    expect(available).not.toBeNull();
    if (available === null) throw new Error("Expected released setup request capacity");
    available();
    const invalid: Response = await fixture.handle(bodyRequest("private input fixture"));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private input fixture");
  } finally {
    await fixture.observability.shutdown();
  }
});
