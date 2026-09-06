import { ChildProcess } from "node:child_process";

import type { LoadChildShutdownClock } from "../../scripts/lib/hosted-load-child-shutdown.js";

export class HostedLoadChildFixture {
  public readonly child: ChildProcess = new ChildProcess();
  public readonly messages: unknown[] = [];
  public readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  public sendAcknowledged: boolean = true;
  public sendError: Error | null = null;
  public sendThrows: boolean = false;
  public killAccepted: boolean = true;
  public killThrows: boolean = false;
  private sendCallback: ((error: Error | null) => void) | null = null;

  public constructor() {
    Object.defineProperty(this.child, "connected", {
      configurable: true,
      value: true,
      writable: true,
    });
    Reflect.set(this.child, "send", (message: unknown, callback: unknown): boolean => {
      this.messages.push(message);
      if (this.sendThrows) throw new Error("Private IPC exception");
      if (typeof callback === "function") {
        this.sendCallback = (error: Error | null): void => {
          callback(error);
        };
        if (this.sendAcknowledged) this.sendCallback(this.sendError);
      }
      return true;
    });
    Reflect.set(this.child, "kill", (signal: NodeJS.Signals | number | undefined): boolean => {
      this.signals.push(signal);
      if (this.killThrows) throw new Error("Private signal exception");
      return this.killAccepted;
    });
  }

  public disconnected(): void {
    Reflect.set(this.child, "connected", false);
  }

  public acknowledge(error: Error | null = null): void {
    if (this.sendCallback === null) throw new Error("No pending fixture IPC callback");
    this.sendCallback(error);
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    Reflect.set(this.child, "exitCode", code);
    Reflect.set(this.child, "signalCode", signal);
    this.child.emit("exit", code, signal);
  }
}

type Scheduled = { readonly id: number; readonly at: number; readonly run: () => void };

export class HostedLoadShutdownClock implements LoadChildShutdownClock {
  private elapsed: number = 0;
  private nextId: number = 0;
  private readonly pending: Map<number, Scheduled> = new Map<number, Scheduled>();

  public now(): number {
    return this.elapsed;
  }

  public schedule(milliseconds: number, run: () => void): () => void {
    const id: number = this.nextId++;
    this.pending.set(id, { id, at: this.elapsed + milliseconds, run });
    return (): void => {
      this.pending.delete(id);
    };
  }

  public advance(milliseconds: number): void {
    const target: number = this.elapsed + milliseconds;
    while (true) {
      let next: Scheduled | null = null;
      for (const timer of this.pending.values()) {
        if (timer.at <= target && (next === null || timer.at < next.at)) next = timer;
      }
      if (next === null) break;
      this.elapsed = next.at;
      this.pending.delete(next.id);
      next.run();
    }
    this.elapsed = target;
  }

  public get timers(): number {
    return this.pending.size;
  }
}
