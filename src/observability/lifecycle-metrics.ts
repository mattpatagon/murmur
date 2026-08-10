import type { LogFields } from "./structured-logger.js";

export type LifecycleEventSink = {
  info(event: string, fields: LogFields): void;
};

export function recordRepositoryDivergence(sink: LifecycleEventSink): void {
  sink.info("agent.repository_divergence", {});
}
