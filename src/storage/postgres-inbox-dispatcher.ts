import type { AgentId, TenantId } from "../domain/value-objects.js";
import { Sequence } from "../domain/value-objects.js";
import type { InboxSubscription, InboxUpdateHandler } from "./message-store.js";

export type InboxDispatcherTimeSource = {
  now(): number;
  schedule(milliseconds: number, wake: () => void): () => void;
};

export const SYSTEM_INBOX_DISPATCHER_TIME: InboxDispatcherTimeSource = {
  now: (): number => Date.now(),
  schedule: (milliseconds: number, wake: () => void): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(wake, milliseconds);
    timer.unref();
    return (): void => clearTimeout(timer);
  },
};

type DeliveryOutcome = "delivered" | "failed" | "timed_out" | "closed";
type DeliveryTask = {
  cancelDeadline: () => void;
  outcomeSettled: boolean;
  readonly outcome: Promise<DeliveryOutcome>;
  readonly resolve: (outcome: DeliveryOutcome) => void;
  readonly sequence: Sequence;
};
type Inbox = {
  readonly agentId: AgentId;
  readonly key: string;
  latestSequence: Sequence;
  readonly subscribers: Set<Subscriber>;
  readonly tenantId: TenantId;
};
type Subscriber = {
  active: boolean;
  failedSequence: Sequence;
  readonly handler: InboxUpdateHandler;
  readonly inbox: Inbox;
  lastSequence: Sequence;
  task: DeliveryTask | null;
};

export type DispatcherSubscription = InboxSubscription & {
  initialize(sequence: Sequence): Promise<void>;
};
export type InboxDispatcherOptions = {
  readonly maxSubscriptions?: number;
  readonly maxSubscriptionsPerTenant?: number;
  readonly maxSubscriptionsPerInbox?: number;
  readonly handlerTimeoutMs?: number;
  readonly catchUpTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly time?: InboxDispatcherTimeSource;
  readonly readVersion: (tenantId: TenantId, agentId: AgentId) => Promise<Sequence>;
  readonly reportError: (error: unknown) => void;
};

function bounded(value: number | undefined, maximum: number): number {
  const selected: number = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error("Invalid inbox dispatcher bounds");
  }
  return selected;
}

function inboxKey(tenantId: TenantId, agentId: AgentId): string {
  return `${tenantId.value}\u0000${agentId.value}`;
}

export class PostgresInboxDispatcher {
  private readonly options: InboxDispatcherOptions;
  private readonly time: InboxDispatcherTimeSource;
  private readonly maximum: number;
  private readonly maximumPerTenant: number;
  private readonly maximumPerInbox: number;
  private readonly handlerTimeoutMs: number;
  private readonly catchUpTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly inboxes: Map<string, Inbox> = new Map<string, Inbox>();
  private readonly occupied: Set<Subscriber> = new Set<Subscriber>();
  private readonly occupiedByTenant: Map<string, number> = new Map<string, number>();
  private readonly occupiedByInbox: Map<string, number> = new Map<string, number>();
  private closed: boolean = false;
  private catchUpRequested: boolean = false;
  private catchingUp: boolean = false;
  private cancelCatchUpDeadline: () => void = (): void => {};

  public constructor(options: InboxDispatcherOptions) {
    this.options = options;
    this.time = options.time ?? SYSTEM_INBOX_DISPATCHER_TIME;
    this.maximum = bounded(options.maxSubscriptions, 16_384);
    this.maximumPerTenant = bounded(options.maxSubscriptionsPerTenant, 1_024);
    this.maximumPerInbox = bounded(options.maxSubscriptionsPerInbox, 128);
    this.handlerTimeoutMs = bounded(options.handlerTimeoutMs, 5_000);
    this.catchUpTimeoutMs = bounded(options.catchUpTimeoutMs, 15_000);
    this.cleanupTimeoutMs = bounded(options.cleanupTimeoutMs, 5_000);
  }

  public subscribe(
    tenantId: TenantId,
    agentId: AgentId,
    afterSequence: Sequence,
    handler: InboxUpdateHandler,
  ): DispatcherSubscription {
    if (this.closed) throw new Error("The inbox dispatcher is closed");
    const key: string = inboxKey(tenantId, agentId);
    const tenantCount: number = this.occupiedByTenant.get(tenantId.value) ?? 0;
    const inboxCount: number = this.occupiedByInbox.get(key) ?? 0;
    if (
      this.occupied.size >= this.maximum ||
      tenantCount >= this.maximumPerTenant ||
      inboxCount >= this.maximumPerInbox
    ) {
      throw new Error("Inbox subscription capacity reached");
    }
    const inbox: Inbox = this.inboxes.get(key) ?? {
      agentId,
      key,
      latestSequence: Sequence.zero(),
      subscribers: new Set<Subscriber>(),
      tenantId,
    };
    const subscriber: Subscriber = {
      active: true,
      failedSequence: Sequence.zero(),
      handler,
      inbox,
      lastSequence: afterSequence,
      task: null,
    };
    this.inboxes.set(key, inbox);
    inbox.subscribers.add(subscriber);
    this.occupied.add(subscriber);
    this.occupiedByTenant.set(tenantId.value, tenantCount + 1);
    this.occupiedByInbox.set(key, inboxCount + 1);
    return {
      close: (): void => this.unsubscribe(subscriber),
      initialize: async (sequence: Sequence): Promise<void> => {
        if (!subscriber.active) throw new Error("The inbox subscription is closed");
        this.publish(tenantId, agentId, sequence);
        this.dispatch(subscriber);
        const task: DeliveryTask | null = subscriber.task;
        if (task !== null && (await task.outcome) !== "delivered") {
          throw new Error("Initial inbox notification delivery failed");
        }
      },
    };
  }

  public publish(tenantId: TenantId, agentId: AgentId, sequence: Sequence): void {
    if (this.closed) return;
    const inbox: Inbox | undefined = this.inboxes.get(inboxKey(tenantId, agentId));
    if (inbox === undefined || !sequence.isAfter(inbox.latestSequence)) return;
    inbox.latestSequence = sequence;
    for (const subscriber of inbox.subscribers) this.dispatch(subscriber);
  }

  private settleTask(task: DeliveryTask, outcome: DeliveryOutcome): void {
    if (task.outcomeSettled) return;
    task.outcomeSettled = true;
    task.cancelDeadline();
    task.resolve(outcome);
  }

  private dispatch(subscriber: Subscriber): void {
    const sequence: Sequence = subscriber.inbox.latestSequence;
    if (
      this.closed ||
      !subscriber.active ||
      subscriber.task !== null ||
      !sequence.isAfter(subscriber.lastSequence) ||
      !sequence.isAfter(subscriber.failedSequence)
    )
      return;
    const completion: {
      readonly promise: Promise<DeliveryOutcome>;
      readonly resolve: (outcome: DeliveryOutcome) => void;
    } = Promise.withResolvers<DeliveryOutcome>();
    const task: DeliveryTask = {
      cancelDeadline: (): void => {},
      outcome: completion.promise,
      outcomeSettled: false,
      resolve: completion.resolve,
      sequence,
    };
    subscriber.task = task;
    task.cancelDeadline = this.time.schedule(this.handlerTimeoutMs, (): void => {
      this.settleTask(task, "timed_out");
      this.options.reportError(new Error("Inbox notification handler timed out"));
    });
    void Promise.resolve()
      .then(async (): Promise<void> => {
        if (!this.closed && subscriber.active) await subscriber.handler(sequence);
      })
      .then(
        (): void => this.finishDelivery(subscriber, task, null),
        (error: unknown): void => this.finishDelivery(subscriber, task, { error }),
      );
  }

  private finishDelivery(
    subscriber: Subscriber,
    task: DeliveryTask,
    failure: { readonly error: unknown } | null,
  ): void {
    if (failure === null) subscriber.lastSequence = task.sequence;
    else {
      subscriber.failedSequence = task.sequence;
      if (!task.outcomeSettled && !this.closed) this.options.reportError(failure.error);
    }
    this.settleTask(task, failure === null ? "delivered" : "failed");
    subscriber.task = null;
    if (subscriber.active) this.dispatch(subscriber);
    else this.release(subscriber);
  }

  private unsubscribe(subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    subscriber.inbox.subscribers.delete(subscriber);
    if (subscriber.inbox.subscribers.size === 0) this.inboxes.delete(subscriber.inbox.key);
    if (subscriber.task === null) this.release(subscriber);
    else this.settleTask(subscriber.task, "closed");
  }

  private release(subscriber: Subscriber): void {
    if (!this.occupied.delete(subscriber)) return;
    const tenantKey: string = subscriber.inbox.tenantId.value;
    const tenantCount: number = (this.occupiedByTenant.get(tenantKey) ?? 1) - 1;
    const inboxCount: number = (this.occupiedByInbox.get(subscriber.inbox.key) ?? 1) - 1;
    if (tenantCount === 0) this.occupiedByTenant.delete(tenantKey);
    else this.occupiedByTenant.set(tenantKey, tenantCount);
    if (inboxCount === 0) this.occupiedByInbox.delete(subscriber.inbox.key);
    else this.occupiedByInbox.set(subscriber.inbox.key, inboxCount);
  }

  public requestCatchUp(): void {
    if (this.closed) return;
    this.catchUpRequested = true;
    if (this.catchingUp) return;
    this.catchingUp = true;
    void this.catchUp().finally((): void => {
      this.catchingUp = false;
      if (this.catchUpRequested && !this.closed) this.requestCatchUp();
    });
  }

  private async catchUp(): Promise<void> {
    while (this.catchUpRequested && !this.closed) {
      this.catchUpRequested = false;
      const inboxes: readonly Inbox[] = Array.from(this.inboxes.values());
      for (const inbox of inboxes) {
        if (this.closed) return;
        if (this.inboxes.get(inbox.key) !== inbox) continue;
        let timedOut: boolean = false;
        this.cancelCatchUpDeadline = this.time.schedule(this.catchUpTimeoutMs, (): void => {
          timedOut = true;
          this.options.reportError(new Error("Inbox notification catch-up timed out"));
        });
        try {
          const sequence: Sequence = await this.options.readVersion(inbox.tenantId, inbox.agentId);
          if (this.inboxes.get(inbox.key) === inbox) {
            for (const subscriber of inbox.subscribers) subscriber.failedSequence = Sequence.zero();
            this.publish(inbox.tenantId, inbox.agentId, sequence);
            for (const subscriber of inbox.subscribers) this.dispatch(subscriber);
          }
        } catch (error: unknown) {
          if (!timedOut && !this.closed) this.options.reportError(error);
        } finally {
          this.cancelCatchUpDeadline();
          this.cancelCatchUpDeadline = (): void => {};
        }
      }
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.catchUpRequested = false;
    this.cancelCatchUpDeadline();
    for (const subscriber of this.occupied) this.unsubscribe(subscriber);
    this.inboxes.clear();
  }

  public async settleCleanup(action: () => Promise<void>): Promise<void> {
    await new Promise<void>((resolve: () => void, reject: (error: unknown) => void): void => {
      let settled: boolean = false;
      const cancel: () => void = this.time.schedule(this.cleanupTimeoutMs, (): void => {
        settled = true;
        reject(new Error("Inbox notification cleanup timed out"));
      });
      void Promise.resolve()
        .then(action)
        .then(
          (): void => {
            if (settled) return;
            settled = true;
            cancel();
            resolve();
          },
          (error: unknown): void => {
            if (settled) return;
            settled = true;
            cancel();
            reject(error);
          },
        );
    });
  }

  public snapshot(): {
    readonly activeInboxes: number;
    readonly occupiedSubscriptions: number;
    readonly catchUpRunning: boolean;
  } {
    return {
      activeInboxes: this.inboxes.size,
      occupiedSubscriptions: this.occupied.size,
      catchUpRunning: this.catchingUp,
    };
  }
}
