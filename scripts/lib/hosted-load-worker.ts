import process from "node:process";

import { type MurmurHttpServer, startHttpServer } from "../../src/http-server.js";
import { verifyLoadWorkerEnvironment } from "./hosted-load-config.js";

function send(message: Record<string, unknown>): void {
  if (process.send !== undefined) process.send(message);
}

async function main(): Promise<void> {
  verifyLoadWorkerEnvironment(process.env);
  const server: MurmurHttpServer = await startHttpServer(process.env);
  send({ kind: "ready", port: server.mcpUrl.port, rss: process.memoryUsage().rss });
  const timer: ReturnType<typeof setInterval> = setInterval((): void => {
    send({ kind: "rss", rss: process.memoryUsage().rss });
  }, 250);
  timer.unref();
  let stopping: boolean = false;
  const stop: () => Promise<void> = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    const deadline: ReturnType<typeof setTimeout> = setTimeout((): never => process.exit(1), 5_000);
    deadline.unref();
    try {
      await server.stop();
      clearTimeout(deadline);
      process.exit(0);
    } catch (_error: unknown) {
      process.exit(1);
    }
  };
  process.on("message", (message: unknown): void => {
    if (message === "stop") void stop();
  });
  process.on("disconnect", (): void => {
    void stop();
  });
  process.on("SIGTERM", (): void => {
    void stop();
  });
}

if (import.meta.main) {
  main().catch((_error: unknown): never => {
    send({ kind: "failed" });
    process.exit(1);
  });
}
