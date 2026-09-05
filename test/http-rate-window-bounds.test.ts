import { expect, test } from "bun:test";

import { HttpCapacityController, type TimeSource } from "../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../src/http/http-config.js";

class RateWindowTime implements TimeSource {
  public current: number = 0;

  public now(): number {
    return this.current;
  }

  public schedule(_milliseconds: number, _wake: () => void): () => void {
    throw new Error("Rate windows must not allocate background timers");
  }
}

function fillWindows(controller: HttpCapacityController): void {
  let accepted: number = 0;
  for (let index: number = 0; index < 65_536; index += 1) {
    if (controller.rateLimitAllows(`bounded-principal-${index}`, 1)) accepted += 1;
  }
  expect(accepted).toBe(65_536);
}

test("rate window saturation refuses new identities without resetting existing throttles", (): void => {
  const time: RateWindowTime = new RateWindowTime();
  const controller: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({}),
    time,
  );
  fillWindows(controller);

  expect(controller.rateLimitAllows("overflow", 1)).toBe(false);
  expect(controller.rateLimitAllows("bounded-principal-0", 1)).toBe(false);
  time.current = 60_000;
  expect(controller.rateLimitAllows("bounded-principal-0", 1)).toBe(true);
  expect(controller.rateLimitAllows("bounded-principal-0", 1)).toBe(false);
  expect(controller.rateLimitAllows("overflow", 1)).toBe(false);
});

test("renewed rate windows do not prevent older windows expiring and freeing capacity", (): void => {
  const time: RateWindowTime = new RateWindowTime();
  const controller: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({}),
    time,
  );
  fillWindows(controller);
  time.current = 60_000;
  expect(controller.rateLimitAllows("bounded-principal-0", 1)).toBe(true);
  time.current = 119_999;
  controller.pruneRateWindows();
  expect(controller.rateLimitAllows("overflow", 1)).toBe(false);
  time.current = 120_000;
  expect(controller.rateLimitAllows("overflow", 1)).toBe(true);
  expect(controller.rateLimitAllows("bounded-principal-1", 1)).toBe(true);
  expect(controller.rateLimitAllows("bounded-principal-1", 1)).toBe(false);
  expect(controller.rateLimitAllows("bounded-principal-0", 1)).toBe(true);
});
