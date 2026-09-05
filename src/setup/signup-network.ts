import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  answerAdminApproval,
  confirmInTerminal,
  parseAdminArguments,
} from "../admin/terminal-client.js";
import { BoundedHttpClientTransport } from "../e2ee/bounded-http-transport.js";
import type { SelfServiceRegistrationInput } from "../hosted/contracts.js";
import type { SignupRuntime } from "./signup.js";

const MAX_RESPONSE_BYTES: number = 16_384;
type RegistrationFetch = (url: URL, init: RequestInit) => Promise<Response>;

async function responseJson(response: Response): Promise<unknown> {
  const media: string = (response.headers.get("content-type") ?? "").split(";")[0] ?? "";
  const declared: string | null = response.headers.get("content-length");
  if (
    media.trim().toLowerCase() !== "application/json" ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
  ) {
    if (response.body !== null) await response.body.cancel();
    throw new Error("Organization registration response is invalid");
  }
  if (response.body === null) throw new Error("Organization registration returned no body");
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total: number = 0;
  try {
    while (true) {
      const next: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Organization registration response exceeds its size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export async function registerOrganization(
  endpoint: string,
  input: SelfServiceRegistrationInput,
  fetcher: RegistrationFetch = fetch,
): Promise<unknown> {
  try {
    const endpointUrl: URL = parseAdminArguments(["tools", "--url", endpoint]).url;
    const response: Response = await fetcher(new URL("/v1/tenants", endpointUrl), {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", accept: "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 201) {
      if (response.body !== null) await response.body.cancel();
      throw new Error("Organization registration did not succeed");
    }
    return await responseJson(response);
  } catch (_error: unknown) {
    throw new Error(
      "Organization registration failed; saved registration details preserve retries",
    );
  }
}

export async function createSignupWorker(
  endpoint: string,
  ownerToken: string,
  confirm: (message: string) => Promise<boolean> = confirmInTerminal,
): Promise<unknown> {
  const client: Client = new Client(
    { name: "murmur-signup", version: packageMetadata.version },
    {
      capabilities: { elicitation: { form: {} } },
    },
  );
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request: ElicitRequest): Promise<ElicitResult> =>
      await answerAdminApproval(request, confirm),
  );
  try {
    const transport: BoundedHttpClientTransport = new BoundedHttpClientTransport(
      parseAdminArguments(["tools", "--url", endpoint]).url,
      new Headers({ Authorization: `Bearer ${ownerToken}` }),
      150_000,
    );
    await client.connect(transport, { timeout: 15_000, maxTotalTimeout: 15_000 });
    const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: "create_access_token",
          arguments: { role: "agent", name: "Everyday agent" },
        },
        CallToolResultSchema,
        { timeout: 150_000, maxTotalTimeout: 150_000 },
      ),
    );
    if (result.isError === true) throw new Error("Worker credential was not created");
    return result.structuredContent;
  } catch (_error: unknown) {
    throw new Error(
      "Worker credential was not confirmed; owner credentials are saved, so rerun signup to resume",
    );
  } finally {
    await client.close();
  }
}

export function createSignupNetworkRuntime(
  confirm: (message: string) => Promise<boolean> = confirmInTerminal,
): SignupRuntime {
  return {
    register: registerOrganization,
    createWorker: async (endpoint: string, token: string): Promise<unknown> =>
      await createSignupWorker(endpoint, token, confirm),
  };
}
