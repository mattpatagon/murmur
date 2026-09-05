import { HttpCapacityController, type TimeSource } from "../../src/http/http-capacity.js";
import { parseHttpServerConfig } from "../../src/http/http-config.js";
import { createPublicSetupHandler, PUBLIC_SETUP_PATH } from "../../src/http/public-setup.js";
import {
  createDefaultHttpObservability,
  type HttpObservability,
} from "../../src/observability/request-observation.js";

type Timer = { readonly deadline: number; readonly wake: () => void };

export class PublicSetupTestTime implements TimeSource {
  #current: number = 0;
  readonly #timers: Set<Timer> = new Set<Timer>();

  public now(): number {
    return this.#current;
  }

  public schedule(milliseconds: number, wake: () => void): () => void {
    const timer: Timer = { deadline: this.#current + milliseconds, wake };
    this.#timers.add(timer);
    return (): void => {
      this.#timers.delete(timer);
    };
  }

  public pending(): number {
    return this.#timers.size;
  }

  public advance(milliseconds: number): void {
    this.#current += milliseconds;
    for (const timer of [...this.#timers]) {
      if (timer.deadline <= this.#current) {
        this.#timers.delete(timer);
        timer.wake();
      }
    }
  }
}

export type SetupHarness = {
  readonly capacity: HttpCapacityController;
  readonly handle: (request: Request) => Promise<Response>;
  readonly observability: HttpObservability;
  readonly time: PublicSetupTestTime;
};

export function publicSetupHarness(): SetupHarness {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  const capacity: HttpCapacityController = new HttpCapacityController(
    parseHttpServerConfig({
      MURMUR_MAX_ACTIVE_REQUESTS: "2",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL: "2",
      MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT: "2",
    }),
    time,
  );
  const observability: HttpObservability = createDefaultHttpObservability({
    MURMUR_LOG_LEVEL: "off",
  });
  const handler: ReturnType<typeof createPublicSetupHandler> = createPublicSetupHandler({
    allowedOrigins: new Set<string>(["https://approved.example"]),
    capacity,
    time,
  });
  return {
    capacity,
    observability,
    time,
    handle: async (request: Request): Promise<Response> =>
      await handler(request, observability.observe(request)),
  };
}

export function setupRequest(
  body: unknown = { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
  additionalHeaders: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${PUBLIC_SETUP_PATH}`, {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...additionalHeaders,
    },
    method: "POST",
  });
}
