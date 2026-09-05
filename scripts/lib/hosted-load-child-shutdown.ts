import type { ChildProcess } from "node:child_process";

import { HostedLoadFailure } from "./hosted-load-config.js";

export type LoadChildShutdownClock = {
  readonly now: () => number;
  readonly schedule: (milliseconds: number, run: () => void) => () => void;
};

const SYSTEM_CLOCK: LoadChildShutdownClock = {
  now: (): number => performance.now(),
  schedule: (milliseconds: number, run: () => void): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(run, milliseconds);
    return (): void => clearTimeout(timer);
  },
};

export function closeHostedLoadChild(
  child: ChildProcess,
  clock: LoadChildShutdownClock = SYSTEM_CLOCK,
): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new HostedLoadFailure("Hosted load child shutdown failed"));
      return;
    }
    const gracefulDeadline: number = clock.now() + 6_000;
    let failed: boolean = false;
    let settled: boolean = false;
    let exited: boolean = false;
    let ipcPending: boolean = child.connected;
    let terminationRequested: boolean = false;
    let forced: boolean = false;
    let cancelIpc: () => void = (): void => {};
    let cancelGraceful: () => void = (): void => {};
    let cancelForced: () => void = (): void => {};

    const finish: (unconfirmed?: boolean) => void = (unconfirmed: boolean = false): void => {
      if (settled || (!unconfirmed && (!exited || ipcPending))) return;
      settled = true;
      cancelIpc();
      cancelGraceful();
      cancelForced();
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (failed || unconfirmed) {
        reject(
          new HostedLoadFailure(
            unconfirmed
              ? "Hosted load child shutdown failed: terminal exit unconfirmed"
              : "Hosted load child shutdown failed",
          ),
        );
      } else resolve();
    };
    const terminate: () => void = (): void => {
      if (settled || exited || terminationRequested || forced) return;
      terminationRequested = true;
      try {
        if (!child.kill("SIGTERM")) failed = true;
      } catch (_error: unknown) {
        failed = true;
      }
    };
    const onError: () => void = (): void => {
      if (settled) return;
      failed = true;
      ipcPending = false;
      cancelIpc();
      terminate();
      finish();
    };
    const onExit: (code: number | null, signal: NodeJS.Signals | null) => void = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      exited = true;
      if (code !== 0 || signal !== null) {
        failed = true;
        ipcPending = false;
      }
      cancelGraceful();
      cancelForced();
      finish();
    };
    child.on("exit", onExit);
    child.on("error", onError);
    cancelGraceful = clock.schedule(Math.max(0, gracefulDeadline - clock.now()), (): void => {
      failed = true;
      ipcPending = false;
      cancelIpc();
      forced = true;
      // Sending SIGKILL is not observing exit. Keep the listener until a bounded final wait ends.
      cancelForced = clock.schedule(2_000, (): void => finish(true));
      try {
        child.kill("SIGKILL");
      } catch (_error: unknown) {
        failed = true;
      }
    });
    if (!ipcPending) {
      terminate();
      return;
    }
    cancelIpc = clock.schedule(
      Math.min(1_000, Math.max(0, gracefulDeadline - clock.now())),
      onError,
    );
    try {
      child.send("stop", (error: Error | null): void => {
        if (settled || !ipcPending) return;
        cancelIpc();
        ipcPending = false;
        if (error != null) {
          onError();
          return;
        }
        finish();
      });
    } catch (_error: unknown) {
      onError();
    }
  });
}
