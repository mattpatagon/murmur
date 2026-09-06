import { expect, test } from "bun:test";

import {
  readPublicationResponse,
  waitForWebsitePublication,
} from "../scripts/verify-website-publication.js";

const EXPECTED: string = "a".repeat(40);

test("publication retries a successful stale response until the exact revision propagates", async (): Promise<void> => {
  let now: number = 0;
  let calls: number = 0;
  const delays: number[] = [];
  const passed: boolean = await waitForWebsitePublication(EXPECTED, {
    now: (): number => now,
    sleep: async (milliseconds: number): Promise<void> => {
      delays.push(milliseconds);
      now += milliseconds;
    },
    read: async (signal: AbortSignal): Promise<unknown> => {
      expect(signal.aborted).toBe(false);
      calls += 1;
      return { revision: calls === 1 ? "b".repeat(40) : EXPECTED };
    },
  });
  expect(passed).toBe(true);
  expect(calls).toBe(2);
  expect(delays).toEqual([2000]);
});

test("unavailable or malformed publications fail within bounded attempts and elapsed time", async (): Promise<void> => {
  for (const mode of ["stale", "invalid", "network"]) {
    let now: number = 0;
    let calls: number = 0;
    const passed: boolean = await waitForWebsitePublication(EXPECTED, {
      now: (): number => now,
      sleep: async (milliseconds: number): Promise<void> => {
        now += milliseconds;
      },
      read: async (): Promise<unknown> => {
        calls += 1;
        now += 1000;
        if (mode === "network") throw new Error("untrusted network diagnostic");
        return mode === "stale" ? { revision: "b".repeat(40) } : null;
      },
    });
    expect(passed).toBe(false);
    expect(now).toBeLessThanOrEqual(60_000);
    expect(calls).toBeLessThanOrEqual(30);
  }
});

test("a response arriving after the absolute deadline cannot pass", async (): Promise<void> => {
  let now: number = 0;
  expect(
    await waitForWebsitePublication(EXPECTED, {
      now: (): number => now,
      sleep: async (): Promise<void> => {
        throw new Error("Unexpected delay");
      },
      read: async (): Promise<unknown> => {
        now = 60_000;
        return { revision: EXPECTED };
      },
    }),
  ).toBe(false);
});

test("publication response parsing rejects oversized, malformed and unsuccessful bodies", async (): Promise<void> => {
  expect(
    await readPublicationResponse(new Response(JSON.stringify({ revision: EXPECTED }))),
  ).toEqual({ revision: EXPECTED });
  for (const response of [
    new Response("x".repeat(4097)),
    new Response("invalid"),
    new Response("{}", { status: 503 }),
  ]) {
    await expect(readPublicationResponse(response)).rejects.toThrow();
  }
});
