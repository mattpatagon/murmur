import { performance } from "node:perf_hooks";
import process from "node:process";

import { z } from "zod";

const RevisionSchema: z.ZodString = z.string().regex(/^[0-9a-f]{40}(?![\s\S])/u);
const ReleaseSchema: z.ZodType<{ readonly revision: string }> = z.object({
  revision: RevisionSchema,
});
const MAXIMUM_BYTES: number = 4096;
export type PublicationRuntime = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly read: (signal: AbortSignal) => Promise<unknown>;
};

export async function waitForWebsitePublication(
  expected: string,
  runtime: PublicationRuntime,
): Promise<boolean> {
  if (!RevisionSchema.safeParse(expected).success) return false;
  const deadline: number = runtime.now() + 60_000;
  for (let attempt: number = 0; attempt < 30; attempt += 1) {
    const remaining: number = deadline - runtime.now();
    if (remaining <= 0) return false;
    try {
      const result: ReturnType<typeof ReleaseSchema.safeParse> = ReleaseSchema.safeParse(
        await runtime.read(
          AbortSignal.timeout(Math.max(1, Math.floor(Math.min(10_000, remaining)))),
        ),
      );
      if (result.success && result.data.revision === expected && runtime.now() < deadline) {
        return true;
      }
    } catch {
      // Transient edge/network failures share the same bounded propagation window as stale 200s.
    }
    const delay: number = Math.min(2_000, deadline - runtime.now());
    if (delay <= 0 || attempt === 29) return false;
    await runtime.sleep(delay);
  }
  return false;
}

export async function readPublicationResponse(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error("Publication response unavailable");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const content: Uint8Array = new Uint8Array(MAXIMUM_BYTES);
  let size: number = 0;
  try {
    while (true) {
      const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAXIMUM_BYTES)
        throw new Error("Publication response too large");
      content.set(next.value, size);
      size += next.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, size)));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

async function main(): Promise<void> {
  try {
    const expected: string = RevisionSchema.parse(process.env["WEBSITE_REVISION"]);
    const origin: string = z.string().url().parse(process.env["WEBSITE_SITE_URL"]);
    const url: URL = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid publication origin");
    }
    url.pathname = "/version.json";
    url.searchParams.set("revision", expected);
    const verified: boolean = await waitForWebsitePublication(expected, {
      now: (): number => performance.now(),
      sleep: async (milliseconds: number): Promise<void> => {
        await new Promise<void>((resolve: () => void): void => {
          setTimeout(resolve, milliseconds);
        });
      },
      read: async (signal: AbortSignal): Promise<unknown> =>
        await readPublicationResponse(
          await fetch(url, { signal, redirect: "error", cache: "no-store" }),
        ),
    });
    if (!verified) throw new Error("Publication did not converge");
    process.stdout.write("The public website serves the deployed Git revision.\n");
  } catch {
    process.stderr.write(
      "The public website did not verify the deployed Git revision within its deadline.\n",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
