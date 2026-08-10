import { type Counter, type Meter, metrics } from "@opentelemetry/api";

const meter: Meter = metrics.getMeter("murmur.agent-lifecycle");
const repositoryDivergenceCounter: Counter = meter.createCounter(
  "murmur.agent.repository_divergence",
  { description: "Agent registrations whose repository differs while another session is live" },
);

export function recordRepositoryDivergence(): void {
  repositoryDivergenceCounter.add(1);
}
