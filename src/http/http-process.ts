import process from "node:process";

import { logSafeError } from "../safe-errors.js";
import type { MurmurHttpServer } from "./http-server-contracts.js";

export type HttpProcessRuntime = {
  readonly once: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly reportFailure: (message: string, error: unknown) => void;
  readonly setExitCode: (code: number) => void;
};

const DEFAULT_RUNTIME: HttpProcessRuntime = {
  once: (signal: "SIGINT" | "SIGTERM", listener: () => void): void => {
    process.once(signal, listener);
  },
  reportFailure: logSafeError,
  setExitCode: (code: number): void => {
    process.exitCode = code;
  },
};

export function runHttpProcess(
  start: () => Promise<MurmurHttpServer>,
  runtime: HttpProcessRuntime = DEFAULT_RUNTIME,
): void {
  void Promise.resolve()
    .then(start)
    .then(
      (server: MurmurHttpServer): void => {
        let stopped: boolean = false;
        const stop: () => void = (): void => {
          if (stopped) return;
          stopped = true;
          void Promise.resolve()
            .then(async (): Promise<void> => await server.stop())
            .catch((error: unknown): void => {
              runtime.reportFailure("Murmur HTTP shutdown failed", error);
              runtime.setExitCode(1);
            });
        };
        runtime.once("SIGINT", stop);
        runtime.once("SIGTERM", stop);
      },
      (error: unknown): void => {
        runtime.reportFailure("Murmur HTTP startup failed", error);
        runtime.setExitCode(1);
      },
    );
}
