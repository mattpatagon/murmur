import { type ChildProcess, fork } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { type HostedLoadConfig, requireLoad } from "./hosted-load-config.js";

const WorkerMessageSchema: z.ZodType<{
  kind: "ready" | "rss" | "failed";
  port?: string | undefined;
  rss?: number | undefined;
}> = z.strictObject({
  kind: z.enum(["ready", "rss", "failed"]),
  port: z
    .string()
    .regex(/^\d{1,5}$/u)
    .optional(),
  rss: z.number().int().nonnegative().safe().optional(),
});

export class HostedLoadServer {
  public peakRssBytes: number = 0;
  private stopped: boolean = false;
  private failure: boolean = false;
  private readonly child: ChildProcess;
  private readonly ready: Promise<URL>;

  public constructor(config: HostedLoadConfig) {
    this.child = fork(fileURLToPath(new URL("./hosted-load-worker.ts", import.meta.url)), [], {
      execPath: process.execPath,
      env: {
        MURMUR_LOAD_DISPOSABLE: "1",
        MURMUR_AUTH_MODE: "multi-tenant",
        MURMUR_ALLOW_BOOTSTRAP: "0",
        MURMUR_DATABASE_URL: config.runtimeUrl,
        MURMUR_DATABASE_TLS_INSECURE: "1",
        MURMUR_HTTP_HOST: "127.0.0.1",
        MURMUR_TENANT_CONTRACT_VERSION: "2",
        MURMUR_MAX_CONCURRENT_AUTHENTICATIONS: "4",
        MURMUR_MAX_SESSIONS: String(config.maxSessionCount),
        MURMUR_LOG_LEVEL: "off",
        PORT: "0",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.ready = new Promise(
      (resolve: (url: URL) => void, reject: (error: Error) => void): void => {
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          this.failure = true;
          this.child.kill("SIGKILL");
          reject(new Error("Hosted load child startup timed out"));
        }, 30_000);
        this.child.on("message", (message: unknown): void => {
          const parsed: ReturnType<typeof WorkerMessageSchema.safeParse> =
            WorkerMessageSchema.safeParse(message);
          if (!parsed.success || parsed.data.kind === "failed") {
            clearTimeout(timer);
            this.failure = true;
            reject(new Error("Hosted load child failed"));
            return;
          }
          if (parsed.data.rss !== undefined) {
            this.peakRssBytes = Math.max(this.peakRssBytes, parsed.data.rss);
            if (this.peakRssBytes > config.maxRssBytes) {
              this.failure = true;
              this.child.kill("SIGKILL");
            }
          }
          if (parsed.data.kind === "ready") {
            clearTimeout(timer);
            const port: number = Number(parsed.data.port);
            if (!Number.isInteger(port) || port < 1 || port > 65_535) {
              reject(new Error("Hosted load child returned invalid readiness"));
              return;
            }
            resolve(new URL(`http://127.0.0.1:${port}/mcp`));
          }
        });
        this.child.on("error", (_error: Error): void => {
          clearTimeout(timer);
          this.failure = true;
          reject(new Error("Hosted load child failed to start"));
        });
        this.child.on("exit", (): void => {
          clearTimeout(timer);
          if (!this.stopped) this.failure = true;
          reject(new Error("Hosted load child exited before readiness"));
        });
      },
    );
  }

  public async url(): Promise<URL> {
    return await this.ready;
  }

  public verifyHealthy(): void {
    requireLoad(
      !this.failure && this.child.exitCode === null,
      "Hosted child exited or exceeded its RSS budget",
    );
  }

  public async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve: () => void): void => {
      const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
        this.child.kill("SIGKILL");
        resolve();
      }, 6_000);
      this.child.once("exit", (): void => {
        clearTimeout(timer);
        resolve();
      });
      if (this.child.connected) this.child.send("stop");
      else this.child.kill("SIGTERM");
    });
  }
}
