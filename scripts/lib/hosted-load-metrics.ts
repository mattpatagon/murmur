import { requireLoad } from "./hosted-load-config.js";

function percentile(samples: readonly number[], percentile_: number): number {
  if (samples.length === 0) return 0;
  const sorted: number[] = [...samples].sort((left: number, right: number): number => left - right);
  const value: number | undefined = sorted[Math.ceil((sorted.length * percentile_) / 100) - 1];
  requireLoad(value !== undefined, "Latency percentile is unavailable");
  return Math.round(value * 100) / 100;
}

export type PhaseReport = {
  readonly phase: string;
  readonly offeredConcurrency: number;
  readonly durationMs: number;
  readonly httpAttempts: number;
  readonly retries: number;
  readonly mcpCapacityResponses: number;
  readonly statusCodes: Readonly<Record<string, number>>;
  readonly attemptsPerSecond: number;
  readonly operations: number;
  readonly operationP50Ms: number;
  readonly operationP95Ms: number;
  readonly operationP99Ms: number;
  readonly attemptP95Ms: number;
};

export class LoadPhase {
  private readonly started: number = performance.now();
  private readonly attempts: number[] = [];
  private readonly operations: number[] = [];
  private readonly statusCodes: Record<string, number> = {};
  public retries: number = 0;
  public mcpCapacityResponses: number = 0;

  public constructor(
    private readonly phase: string,
    private readonly offeredConcurrency: number,
  ) {}

  public recordAttempt(status: number, duration: number): void {
    requireLoad(this.attempts.length < 1_000_000, "Load phase attempt limit reached");
    this.attempts.push(duration);
    const key: string = String(status);
    this.statusCodes[key] = (this.statusCodes[key] ?? 0) + 1;
  }

  public recordOperation(duration: number): void {
    requireLoad(this.operations.length < 300_000, "Load phase operation limit reached");
    this.operations.push(duration);
  }

  public report(): PhaseReport {
    const durationMs: number = performance.now() - this.started;
    return {
      phase: this.phase,
      offeredConcurrency: this.offeredConcurrency,
      durationMs: Math.round(durationMs),
      httpAttempts: this.attempts.length,
      retries: this.retries,
      mcpCapacityResponses: this.mcpCapacityResponses,
      statusCodes: { ...this.statusCodes },
      attemptsPerSecond:
        Math.round((this.attempts.length / Math.max(durationMs, 1)) * 100_000) / 100,
      operations: this.operations.length,
      operationP50Ms: percentile(this.operations, 50),
      operationP95Ms: percentile(this.operations, 95),
      operationP99Ms: percentile(this.operations, 99),
      attemptP95Ms: percentile(this.attempts, 95),
    };
  }
}
