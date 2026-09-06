import { type HostedLoadConfig, loadWorkers, requireLoad } from "./hosted-load-config.js";
import type { LoadTenant } from "./hosted-load-fixture.js";
import { LoadHttpClient } from "./hosted-load-http.js";
import { LoadPhase, type PhaseReport } from "./hosted-load-metrics.js";
import type { HostedLoadServer } from "./hosted-load-server.js";

export class HostedLoadScenarios {
  public currentPhase: string = "starting";
  public readonly reports: PhaseReport[] = [];
  public readonly exercised: Set<number> = new Set<number>();

  public constructor(
    private readonly config: HostedLoadConfig,
    private readonly tenants: readonly LoadTenant[],
    private readonly url: URL,
    private readonly signal: AbortSignal,
    private readonly server: HostedLoadServer,
  ) {}

  private tenant(index: number): LoadTenant {
    const tenant: LoadTenant | undefined = this.tenants[index % this.tenants.length];
    requireLoad(tenant !== undefined, "Load tenant fixture is unavailable");
    return tenant;
  }

  private record(phase: LoadPhase, latencyGate: boolean = true): void {
    const report: PhaseReport = phase.report();
    this.reports.push(report);
    this.server.verifyHealthy();
    requireLoad(
      !latencyGate ||
        (report.operationP95Ms <= this.config.p95Ms && report.operationP99Ms <= this.config.p99Ms),
      "Hosted load latency exceeded its configured threshold",
    );
  }

  public async ramp(): Promise<void> {
    for (const concurrency of [1, 4, 16, 64]) {
      const name: string = `ramp-${concurrency}`;
      this.currentPhase = name;
      const phase: LoadPhase = new LoadPhase(name, concurrency);
      const client: LoadHttpClient = new LoadHttpClient(this.url, phase, this.signal);
      try {
        await loadWorkers(
          Math.min(128, this.tenants.length - 64),
          concurrency,
          async (index: number): Promise<void> => {
            const tenant: LoadTenant = this.tenant(index);
            await client.journey(tenant, name);
            this.exercised.add(tenant.index);
          },
        );
      } finally {
        this.record(phase);
      }
    }
  }

  public async maliciousTraffic(cold: boolean): Promise<void> {
    const name: string = cold ? "cold-credentials-under-attack" : "known-credentials-under-attack";
    this.currentPhase = name;
    const valid: LoadPhase = new LoadPhase(name, 8);
    const phases: LoadPhase[] = [];
    const victim: LoadTenant = this.tenant(0);
    const client: LoadHttpClient = new LoadHttpClient(this.url, valid, this.signal);
    const jobs: Promise<void>[] = [
      loadWorkers(64, 8, async (index: number): Promise<void> => {
        const tenant: LoadTenant = this.tenant(cold ? this.tenants.length - 64 + index : index);
        await client.journey(tenant, name);
        this.exercised.add(tenant.index);
      }),
    ];
    for (const kind of ["malformed", "known-key", "unknown-key"]) {
      requireLoad(
        kind === "malformed" || kind === "known-key" || kind === "unknown-key",
        "Invalid attack fixture",
      );
      const attack: LoadPhase = new LoadPhase(`${name}:${kind}`, 22);
      phases.push(attack);
      const attacker: LoadHttpClient = new LoadHttpClient(this.url, attack, this.signal);
      jobs.push(
        loadWorkers(1_024, 22, async (): Promise<void> => await attacker.forged(victim, kind)),
      );
    }
    try {
      const results: PromiseSettledResult<void>[] = await Promise.allSettled(jobs);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } finally {
      for (const phase of phases) this.record(phase, false);
      this.record(valid);
    }
    const recovery: LoadPhase = new LoadPhase(`${name}:recovery`, 1);
    const recovered: LoadHttpClient = new LoadHttpClient(this.url, recovery, this.signal);
    try {
      await recovered.journey(victim, `${name}:recovery`);
    } finally {
      this.record(recovery);
    }
  }

  public async accounts(): Promise<void> {
    this.currentPhase = "all-accounts-mixed-http";
    const phase: LoadPhase = new LoadPhase(this.currentPhase, this.config.concurrency);
    const client: LoadHttpClient = new LoadHttpClient(this.url, phase, this.signal);
    try {
      await loadWorkers(
        this.tenants.length,
        this.config.concurrency,
        async (index: number): Promise<void> => {
          const tenant: LoadTenant = this.tenant(index);
          await client.journey(tenant, "full-account-sweep");
          this.exercised.add(tenant.index);
        },
      );
    } finally {
      this.record(phase);
    }
  }

  public async sessionIsolation(): Promise<void> {
    this.currentPhase = "foreign-session-isolation";
    const phase: LoadPhase = new LoadPhase(this.currentPhase, 1);
    const client: LoadHttpClient = new LoadHttpClient(this.url, phase, this.signal);
    const owner: LoadTenant = this.tenant(0);
    const attacker: LoadTenant = this.tenant(1);
    const session: string = await client.initialize(owner);
    try {
      await client.foreignSession(attacker, session);
      await client.forged(owner, "known-key");
    } finally {
      await client.disconnect(owner, session);
      this.record(phase);
    }
  }

  public async saturation(): Promise<void> {
    this.currentPhase = "session-and-stream-saturation";
    const phase: LoadPhase = new LoadPhase(this.currentPhase, 1);
    const client: LoadHttpClient = new LoadHttpClient(this.url, phase, this.signal);
    const sessions: { tenant: LoadTenant; id: string }[] = [];
    const streams: Response[] = [];
    try {
      for (let index: number = 0; index < this.config.maxSessionCount; index += 1) {
        const tenant: LoadTenant = this.tenant(index);
        const id: string = await client.initialize(tenant);
        sessions.push({ tenant, id });
        this.server.verifyHealthy();
      }
      await client.saturatedInitialize(this.tenant(this.config.maxSessionCount));
      for (let index: number = 0; index < 64; index += 1) {
        const session: { tenant: LoadTenant; id: string } | undefined = sessions[index];
        requireLoad(session !== undefined, "Load saturation session is missing");
        streams.push(await client.stream(session.tenant, session.id, 200));
      }
      const overflow: { tenant: LoadTenant; id: string } | undefined = sessions[64] ?? sessions[0];
      requireLoad(overflow !== undefined, "Load overflow session is missing");
      await client.stream(overflow.tenant, overflow.id, 503);
    } finally {
      const cleanup: PromiseSettledResult<void>[] = await Promise.allSettled(
        streams.map(async (stream: Response): Promise<void> => {
          if (stream.body !== null) await stream.body.cancel();
        }),
      );
      let disconnectFailed: boolean = false;
      await loadWorkers(sessions.length, 8, async (index: number): Promise<void> => {
        const session: { tenant: LoadTenant; id: string } | undefined = sessions[index];
        requireLoad(session !== undefined, "Load cleanup session is missing");
        try {
          await client.disconnect(session.tenant, session.id);
        } catch (_error: unknown) {
          disconnectFailed = true;
        }
      });
      this.record(phase, false);
      requireLoad(
        !disconnectFailed &&
          cleanup.every(
            (result: PromiseSettledResult<void>): boolean => result.status === "fulfilled",
          ),
        "Load saturation cleanup failed",
      );
    }
    this.currentPhase = "saturation-recovery";
    const recovery: LoadPhase = new LoadPhase(this.currentPhase, 1);
    const recovered: LoadHttpClient = new LoadHttpClient(this.url, recovery, this.signal);
    try {
      const tenant: LoadTenant = this.tenant(0);
      await recovered.journey(tenant, "saturation-recovery");
      const session: string = await recovered.initialize(tenant);
      try {
        const stream: Response = await recovered.stream(tenant, session, 200);
        if (stream.body !== null) await stream.body.cancel();
      } finally {
        await recovered.disconnect(tenant, session);
      }
    } finally {
      this.record(recovery);
    }
  }
}
