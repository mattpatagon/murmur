import { readFileSync, statSync } from "node:fs";
import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import packageMetadata from "../../package.json" with { type: "json" };
import { BoundedHttpClientTransport } from "../e2ee/bounded-http-transport.js";
import { DEFAULT_MURMUR_URL } from "../setup/user-configuration.js";

const MAX_ARGUMENT_BYTES: number = 32_768;
const COMMAND_TIMEOUT_MS: number = 150_000;

export type AdminArguments = {
  readonly argumentsFile: string | null;
  readonly tool: string;
  readonly url: URL;
};

export type AdminCliRuntime = {
  readonly confirm: (message: string) => Promise<boolean>;
  readonly interactive: boolean;
  readonly token: string | undefined;
};

export function parseAdminArguments(arguments_: readonly string[]): AdminArguments {
  const tool: string | undefined = arguments_[0];
  if (tool === undefined || !/^[a-z][a-z_]{0,79}$/u.test(tool)) {
    throw new Error(
      "Usage: murmur admin TOOL [--arguments-file FILE] [--url URL]; use tools to list available operations",
    );
  }
  let argumentsFile: string | null = null;
  let endpoint: string = DEFAULT_MURMUR_URL;
  const seen: Set<string> = new Set<string>();
  for (let index: number = 1; index < arguments_.length; index += 2) {
    const option: string | undefined = arguments_[index];
    const value: string | undefined = arguments_[index + 1];
    if (option === undefined || value === undefined || seen.has(option)) {
      throw new Error("Admin options require one value each and may not be repeated");
    }
    seen.add(option);
    if (option === "--arguments-file") argumentsFile = value;
    else if (option === "--url") endpoint = value;
    else throw new Error("Unknown admin option");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (_error: unknown) {
    throw new Error("The admin endpoint URL is invalid");
  }
  const loopback: boolean = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Admin endpoint must use HTTPS outside loopback and may not contain credentials or parameters",
    );
  }
  return { argumentsFile, tool, url };
}

export function readAdminArguments(path: string | null): Record<string, unknown> {
  if (path === null) return {};
  const size: number = statSync(path).size;
  if (size > MAX_ARGUMENT_BYTES) throw new Error("Admin arguments exceed 32 KiB");
  const content: string = readFileSync(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error("Admin arguments exceed 32 KiB");
  }
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(content));
  } catch (_error: unknown) {
    throw new Error("Admin arguments must be a JSON object");
  }
}

const ApprovalSchema: z.ZodType<{
  readonly confirmation: { readonly enum: readonly string[]; readonly type: "string" };
}> = z.strictObject({
  confirmation: z.object({
    enum: z.array(z.string().regex(/^approve:[0-9a-f-]{36}$/u)).length(1),
    type: z.literal("string"),
  }),
});

export async function answerAdminApproval(
  request: ElicitRequest,
  confirm: (message: string) => Promise<boolean>,
): Promise<ElicitResult> {
  if (request.params.mode === "url") return { action: "decline" };
  const properties: z.ZodSafeParseResult<z.infer<typeof ApprovalSchema>> = ApprovalSchema.safeParse(
    request.params.requestedSchema.properties,
  );
  if (!properties.success) return { action: "decline" };
  const confirmation: string | undefined = properties.data.confirmation.enum[0];
  if (confirmation === undefined) return { action: "decline" };
  const accepted: boolean = await confirm(request.params.message);
  return accepted ? { action: "accept", content: { confirmation } } : { action: "decline" };
}

export async function confirmInTerminal(message: string): Promise<boolean> {
  const terminal: Interface = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // An untrusted remote field must not inject terminal escape sequences into a consent prompt.
    const printable: string = [...message]
      .filter((character: string): boolean => {
        const code: number = character.charCodeAt(0);
        return code === 10 || code === 9 || (code >= 32 && (code < 127 || code > 159));
      })
      .join("");
    process.stderr.write(`\n${printable}\n\n`);
    const answer: string = await terminal.question(
      "Type approve to authorize this exact change, or press Enter to decline: ",
      {
        signal: AbortSignal.timeout(110_000),
      },
    );
    return answer === "approve";
  } catch (_error: unknown) {
    return false;
  } finally {
    terminal.close();
  }
}

export async function runAdminCli(
  arguments_: readonly string[],
  runtime: AdminCliRuntime = {
    confirm: confirmInTerminal,
    interactive:
      process.stdin.isTTY === true &&
      process.stderr.isTTY === true &&
      process.stdout.isTTY === true,
    token: process.env["MURMUR_ADMIN_TOKEN"],
  },
): Promise<string> {
  const options: AdminArguments = parseAdminArguments(arguments_);
  if (!runtime.interactive) {
    throw new Error(
      "murmur admin requires a human-controlled interactive terminal; redirected or automated approval is unavailable",
    );
  }
  const token: string | undefined = runtime.token;
  if (token === undefined || !/^[\x21-\x7e]{1,256}$/u.test(token)) {
    throw new Error(
      "Set MURMUR_ADMIN_TOKEN from your owner or operator secret store in this terminal",
    );
  }
  const input: Record<string, unknown> = readAdminArguments(options.argumentsFile);
  const client: Client = new Client(
    { name: "murmur-human-admin", version: packageMetadata.version },
    {
      capabilities: { elicitation: { form: {} } },
    },
  );
  const transport: BoundedHttpClientTransport = new BoundedHttpClientTransport(
    options.url,
    new Headers({ Authorization: `Bearer ${token}` }),
    COMMAND_TIMEOUT_MS,
  );
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request: ElicitRequest): Promise<ElicitResult> =>
      await answerAdminApproval(request, runtime.confirm),
  );
  try {
    await client.connect(transport, { timeout: 15_000, maxTotalTimeout: 15_000 });
    if (options.tool === "tools") {
      const tools: Tool[] = (
        await client.listTools({}, { timeout: 15_000, maxTotalTimeout: 15_000 })
      ).tools;
      return `${JSON.stringify(tools, null, 2)}\n`;
    }
    const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(
      await client.callTool(
        {
          arguments: input,
          name: options.tool,
        },
        CallToolResultSchema,
        { timeout: COMMAND_TIMEOUT_MS, maxTotalTimeout: COMMAND_TIMEOUT_MS },
      ),
    );
    if (result.isError === true) {
      throw new Error(
        "The admin operation failed; inspect the service and retry after correcting the request",
      );
    }
    return `${JSON.stringify(result.structuredContent ?? result.content, null, 2)}\n`;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("The admin operation failed"))
      throw error;
    throw new Error("The admin connection or approval failed; no success was confirmed");
  } finally {
    await client.close();
  }
}
