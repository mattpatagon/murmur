import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export type LoadHttpRuntime = {
  readonly fetch: (url: URL, options: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export const LOAD_HTTP_RUNTIME: LoadHttpRuntime = {
  fetch: async (url: URL, options: RequestInit): Promise<Response> => await fetch(url, options),
  now: (): number => performance.now(),
  wait: async (milliseconds: number, signal: AbortSignal): Promise<void> => {
    await delay(milliseconds, undefined, { signal });
  },
};

type CapacityEnvelope = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly error: {
    readonly code: -32003;
    readonly message: string;
    readonly data: { readonly retryable: true; readonly retry_after_ms: 1000 };
  };
};
const CapacityEnvelopeSchema: z.ZodType<CapacityEnvelope> = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().int()]),
  error: z.strictObject({
    code: z.literal(-32003),
    message: z.enum([
      "MCP error -32003: MCP processing capacity reached; retry later.",
      "MCP error -32003: MCP materialization capacity reached; retry later.",
    ]),
    data: z.strictObject({ retryable: z.literal(true), retry_after_ms: z.literal(1000) }),
  }),
});

export function isLoadCapacityResponse(
  payload: unknown,
  request: Record<string, unknown> | null,
): boolean {
  // Admission failures are safe to repeat; an arbitrary MCP/tool error is not retry permission.
  if (request === null || request["jsonrpc"] !== "2.0") return false;
  const parsed: z.ZodSafeParseResult<CapacityEnvelope> = CapacityEnvelopeSchema.safeParse(payload);
  return parsed.success && parsed.data.id === request["id"];
}
