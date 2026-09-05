import { expect, test } from "bun:test";
import { publicSetupResponse } from "../src/http/public-setup-response.js";
import { PublicSetupTestTime } from "./support/public-setup-harness.js";

test("public setup response releases once on bodyless, successful and failed responses", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  let released: number = 0;
  const release: () => void = (): void => {
    released += 1;
  };
  expect(publicSetupResponse(new Response(null, { status: 202 }), release, time).status).toBe(202);
  expect(released).toBe(1);
  expect(await publicSetupResponse(new Response("guide"), release, time).text()).toBe("guide");
  expect(released).toBe(2);
  const failed: Response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.error(new Error("private failure details"));
      },
    }),
  );
  await expect(publicSetupResponse(failed, release, time).text()).rejects.toThrow(
    "Public setup response failed",
  );
  expect(released).toBe(3);
  expect(time.pending()).toBe(0);
  time.advance(30_000);
  expect(released).toBe(3);
});

test("public setup response cancellation and absolute deadline cannot be held by hostile upstream cleanup", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  let released: number = 0;
  let cancelled: number = 0;
  const source: () => Response = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel: (): Promise<void> => {
          cancelled += 1;
          return new Promise<void>((): void => undefined);
        },
      }),
    );
  const first: Response = publicSetupResponse(
    source(),
    (): void => {
      released += 1;
    },
    time,
  );
  if (first.body === null) throw new Error("Expected body fixture");
  await first.body.cancel();
  expect(released).toBe(1);
  const second: Response = publicSetupResponse(
    source(),
    (): void => {
      released += 1;
    },
    time,
  );
  time.advance(30_000);
  await expect(second.text()).rejects.toThrow("deadline");
  expect(released).toBe(2);
  expect(cancelled).toBe(2);
  expect(time.pending()).toBe(0);
});
