import { type ChildProcess, execFile } from "node:child_process";
import process from "node:process";

import {
  ProductionStreamLogFailure,
  requireStreamLog,
  STREAM_LOG_MAX_BYTES,
  streamLogJson,
} from "./production-stream-log-contracts.js";

export type StreamLogRuntime = {
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly execute: (arguments_: readonly string[], timeoutMs: number) => Promise<string>;
  readonly release: (origin: string, timeoutMs: number) => Promise<unknown>;
};

export type StreamLogCommandDriver = {
  readonly start: (
    arguments_: readonly string[],
    timeoutMs: number,
    completed: (error: Error | null, stdout: string) => void,
  ) => { readonly stop: () => void };
  readonly schedule: (milliseconds: number, run: () => void) => () => void;
};

const COMMAND_DRIVER: StreamLogCommandDriver = {
  start: (
    arguments_: readonly string[],
    timeoutMs: number,
    completed: (error: Error | null, stdout: string) => void,
  ): { readonly stop: () => void } => {
    const child: ChildProcess = execFile(
      "gcloud",
      arguments_,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: STREAM_LOG_MAX_BYTES,
        windowsHide: true,
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
      },
      completed,
    );
    return {
      stop: (): void => {
        try {
          child.kill("SIGKILL");
        } finally {
          if (child.stdout !== null) child.stdout.destroy();
          if (child.stderr !== null) child.stderr.destroy();
        }
      },
    };
  },
  schedule: (milliseconds: number, run: () => void): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(run, milliseconds);
    return (): void => clearTimeout(timer);
  },
};

export async function executeStreamLogCommand(
  arguments_: readonly string[],
  timeoutMs: number,
  driver: StreamLogCommandDriver = COMMAND_DRIVER,
): Promise<string> {
  requireStreamLog(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000);
  return await new Promise<string>(
    (resolve: (value: string) => void, reject: (error: Error) => void): void => {
      let child: { readonly stop: () => void } | null = null;
      let settled: boolean = false;
      const cancel: () => void = driver.schedule(timeoutMs, (): void => {
        if (settled) return;
        settled = true;
        // execFile's child timeout alone does not bound inherited stdout/stderr pipe lifetime.
        try {
          if (child !== null) child.stop();
        } catch (_error: unknown) {
          // Timeout is already a fixed failure; cleanup details must not escape.
        } finally {
          reject(new ProductionStreamLogFailure());
        }
      });
      try {
        child = driver.start(
          arguments_,
          Math.max(1, timeoutMs - 1_000),
          (error: Error | null, stdout: string): void => {
            if (settled) return;
            settled = true;
            cancel();
            if (error !== null || Buffer.byteLength(stdout, "utf8") > STREAM_LOG_MAX_BYTES) {
              reject(new ProductionStreamLogFailure());
            } else resolve(stdout);
          },
        );
      } catch (_error: unknown) {
        if (settled) return;
        settled = true;
        cancel();
        reject(new ProductionStreamLogFailure());
      }
    },
  );
}

async function readRelease(origin: string, timeoutMs: number): Promise<unknown> {
  const response: Response = await fetch(new URL("/version", origin), {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  requireStreamLog(response.ok && response.body !== null);
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size: number = 0;
  try {
    requireStreamLog(
      (response.headers.get("content-type") ?? "").toLowerCase().split(";")[0] ===
        "application/json",
    );
    while (true) {
      const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      requireStreamLog(size <= STREAM_LOG_MAX_BYTES);
      chunks.push(chunk.value);
    }
    return streamLogJson(Buffer.concat(chunks).toString("utf8"));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export const STREAM_LOG_RUNTIME: StreamLogRuntime = {
  now: (): number => performance.now(),
  timestamp: (): string => new Date().toISOString(),
  sleep: async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, milliseconds);
    });
  },
  execute: executeStreamLogCommand,
  release: readRelease,
};

export class StreamLogDeadline {
  private readonly deadline: number;
  public constructor(
    private readonly runtime: StreamLogRuntime,
    maximumMs: number,
  ) {
    this.deadline = runtime.now() + maximumMs;
  }
  public remaining(maximumMs: number = 30_000): number {
    const remaining: number = Math.floor(Math.min(maximumMs, this.deadline - this.runtime.now()));
    requireStreamLog(remaining > 0);
    return remaining;
  }
  public async command(arguments_: readonly string[]): Promise<unknown> {
    const text: string = await this.runtime.execute(arguments_, this.remaining());
    this.remaining();
    return streamLogJson(text);
  }
  public async pause(milliseconds: number): Promise<void> {
    requireStreamLog(this.remaining(milliseconds) === milliseconds);
    await this.runtime.sleep(milliseconds);
    this.remaining();
  }
}
