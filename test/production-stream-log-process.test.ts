import { expect, test } from "bun:test";

import {
  ProductionStreamLogFailure,
  STREAM_LOG_MAX_BYTES,
} from "../scripts/lib/production-stream-log-contracts.js";
import {
  executeStreamLogCommand,
  type StreamLogCommandDriver,
} from "../scripts/lib/production-stream-log-process.js";

class CommandFixture implements StreamLogCommandDriver {
  public elapsed: number = 0;
  public stops: number = 0;
  public throwOnStart: boolean = false;
  public throwOnStop: boolean = false;
  public childTimeout: number | null = null;
  public arguments: readonly string[] = [];
  private timer: { readonly at: number; readonly run: () => void } | null = null;
  private completion: ((error: Error | null, stdout: string) => void) | null = null;
  public readonly start: StreamLogCommandDriver["start"] = (
    arguments_: readonly string[],
    timeoutMs: number,
    completed: (error: Error | null, stdout: string) => void,
  ): { readonly stop: () => void } => {
    if (this.throwOnStart) throw new Error("private-command-sentinel");
    this.arguments = [...arguments_];
    this.childTimeout = timeoutMs;
    this.completion = completed;
    return {
      stop: (): void => {
        this.stops += 1;
        if (this.throwOnStop) throw new Error("private-cleanup-sentinel");
      },
    };
  };
  public readonly schedule: StreamLogCommandDriver["schedule"] = (
    milliseconds: number,
    run: () => void,
  ): (() => void) => {
    if (this.timer !== null) throw new Error("Unexpected second fixture timer");
    this.timer = { at: this.elapsed + milliseconds, run };
    return (): void => {
      this.timer = null;
    };
  };
  public advance(milliseconds: number): void {
    this.elapsed += milliseconds;
    const timer: typeof this.timer = this.timer;
    if (timer !== null && timer.at <= this.elapsed) {
      this.timer = null;
      timer.run();
    }
  }
  public finish(error: Error | null, stdout: string): void {
    if (this.completion === null) throw new Error("Command fixture was not started");
    this.completion(error, stdout);
  }
}

test("a held output pipe cannot outlive the whole-command watchdog", async (): Promise<void> => {
  const fixture: CommandFixture = new CommandFixture();
  let completed: boolean = false;
  const pending: Promise<string> = executeStreamLogCommand(
    ["logging", "read", "safe-filter"],
    30_000,
    fixture,
  );
  const rejected: Promise<void> = pending.then(
    (): void => {
      completed = true;
    },
    (error: unknown): void => {
      completed = true;
      expect(error).toBeInstanceOf(ProductionStreamLogFailure);
      expect(error instanceof Error ? error.message : "").toBe(
        "Production stream log verification failed",
      );
    },
  );
  expect(fixture.childTimeout).toBe(29_000);
  fixture.advance(29_999);
  await Promise.resolve();
  expect(completed).toBe(false);
  fixture.advance(1);
  await rejected;
  expect(completed).toBe(true);
  expect(fixture.stops).toBe(1);
  fixture.finish(null, "private late stdout");
  fixture.advance(30_000);
  expect(fixture.stops).toBe(1);
});

test("successful subprocess completion cancels the watchdog and preserves bounded output exactly", async (): Promise<void> => {
  const fixture: CommandFixture = new CommandFixture();
  const pending: Promise<string> = executeStreamLogCommand(
    ["logging", "read", "safe-filter"],
    2_000,
    fixture,
  );
  fixture.finish(null, "[]\n");
  expect(await pending).toBe("[]\n");
  fixture.advance(10_000);
  expect(fixture.stops).toBe(0);
  expect(fixture.arguments).toEqual(["logging", "read", "safe-filter"]);
});

test("spawn, exit, byte-limit and watchdog cleanup faults expose only the fixed safe error", async (): Promise<void> => {
  for (const fault of ["spawn", "exit", "bytes", "cleanup"]) {
    const fixture: CommandFixture = new CommandFixture();
    fixture.throwOnStart = fault === "spawn";
    fixture.throwOnStop = fault === "cleanup";
    const pending: Promise<string> = executeStreamLogCommand(["logging", "read"], 5_000, fixture);
    if (fault === "exit")
      fixture.finish(new Error("private-stderr-sentinel"), "private-output-sentinel");
    if (fault === "bytes") fixture.finish(null, "x".repeat(STREAM_LOG_MAX_BYTES + 1));
    if (fault === "cleanup") fixture.advance(5_000);
    await expect(pending).rejects.toThrow("Production stream log verification failed");
  }
});

test("subprocess timeouts reject invalid or unbounded durations before launch", async (): Promise<void> => {
  for (const timeout of [0, -1, 30_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    const fixture: CommandFixture = new CommandFixture();
    await expect(executeStreamLogCommand(["logging", "read"], timeout, fixture)).rejects.toThrow(
      ProductionStreamLogFailure,
    );
    expect(fixture.arguments).toEqual([]);
  }
});
