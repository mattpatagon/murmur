import { logSafeError } from "../safe-errors.js";

export type ResourceCleanup = {
  close(): Promise<void>;
  readonly context: string;
};

export async function closeResources(cleanups: readonly ResourceCleanup[]): Promise<void> {
  const errors: unknown[] = [];
  let index: number = 0;
  while (index < cleanups.length) {
    const cleanup: ResourceCleanup | undefined = cleanups[index];
    if (cleanup === undefined) throw new Error("A resource cleanup disappeared");
    try {
      await cleanup.close();
    } catch (error: unknown) {
      errors.push(error);
      logSafeError(cleanup.context, error);
    }
    index += 1;
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Murmur resource shutdown failed in ${errors.length} step(s)`);
  }
}

export async function cleanupAfterFailure(cleanups: readonly ResourceCleanup[]): Promise<void> {
  try {
    await closeResources(cleanups);
  } catch (_cleanupError: unknown) {
    // closeResources logs each sanitized cleanup failure; preserve the primary startup error.
  }
}
