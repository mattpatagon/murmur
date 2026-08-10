import type { HttpObservability } from "../observability/request-observation.js";
import { cleanupAfterFailure, closeResources } from "./resource-lifecycle.js";

export type AsyncCloseable = { close(): Promise<void> | void };
export type ForceStoppable = { stop(closeActiveConnections: boolean): Promise<void> };

export async function cleanupObservabilityStartup(
  authenticator: AsyncCloseable,
  store: AsyncCloseable,
): Promise<void> {
  await cleanupAfterFailure([
    {
      close: async (): Promise<void> => await authenticator.close(),
      context: "Murmur authenticator startup cleanup failed",
    },
    {
      close: async (): Promise<void> => await store.close(),
      context: "Murmur store startup cleanup failed",
    },
  ]);
}

export async function cleanupStoreStartup(store: AsyncCloseable): Promise<void> {
  await cleanupAfterFailure([
    {
      close: async (): Promise<void> => await store.close(),
      context: "Murmur store startup cleanup failed",
    },
  ]);
}

export async function cleanupServerStartup(
  authenticator: AsyncCloseable,
  store: AsyncCloseable,
  observability: HttpObservability,
  server: ForceStoppable | null,
): Promise<void> {
  const serverCleanups: readonly {
    close(): Promise<void>;
    readonly context: string;
  }[] =
    server === null
      ? []
      : [
          {
            close: async (): Promise<void> => await server.stop(true),
            context: "Murmur HTTP startup cleanup failed",
          },
        ];
  await cleanupAfterFailure([
    ...serverCleanups,
    {
      close: async (): Promise<void> => await authenticator.close(),
      context: "Murmur authenticator startup cleanup failed",
    },
    {
      close: async (): Promise<void> => await store.close(),
      context: "Murmur store startup cleanup failed",
    },
    {
      close: async (): Promise<void> => await observability.shutdown(),
      context: "Murmur telemetry startup cleanup failed",
    },
  ]);
}

export async function shutdownHttpResources(
  server: ForceStoppable,
  closeSessions: () => Promise<void>,
  authenticator: AsyncCloseable,
  store: AsyncCloseable,
  observability: HttpObservability,
): Promise<void> {
  await closeResources([
    {
      close: async (): Promise<void> => await server.stop(true),
      context: "Murmur HTTP shutdown failed",
    },
    { close: closeSessions, context: "Murmur session shutdown failed" },
    {
      close: async (): Promise<void> => await authenticator.close(),
      context: "Murmur authenticator shutdown failed",
    },
    {
      close: async (): Promise<void> => await store.close(),
      context: "Murmur store shutdown failed",
    },
    {
      close: async (): Promise<void> => await observability.shutdown(),
      context: "Murmur telemetry shutdown failed",
    },
  ]);
}
