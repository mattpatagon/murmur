#!/usr/bin/env bun

import process from "node:process";

import { CallToolResultSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  IssuedOperatorTokenOutputSchema,
  TenantStatusOutputSchema,
} from "../src/hosted/contracts.js";
import { DatabaseCredentialPattern } from "../src/hosted/token-secret.js";
import { logSafeError } from "../src/safe-errors.js";

const JsonRpcEnvelopeSchema: z.ZodObject<{ result: z.ZodType<unknown> }> = z.object({
  result: z.unknown(),
});

class LegacyTokenFormatError extends Error {
  public constructor() {
    super(
      "MURMUR_LEGACY_TOKEN cannot be adopted because strict authentication does not accept its format",
    );
    this.name = "LegacyTokenFormatError";
  }
}

function requiredEnvironment(name: string): string {
  const value: string | undefined = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function headers(token: string, sessionId: string | null): Headers {
  const result: Headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Murmur-Branch": "production-bootstrap",
    "X-Murmur-Client": "codex",
    "X-Murmur-Repository": "mattpatagon/murmur",
  });
  if (sessionId !== null) {
    result.set("Mcp-Session-Id", sessionId);
    result.set("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  }
  return result;
}

async function payload(response: Response): Promise<unknown> {
  const body: string = await response.text();
  if (!response.ok) throw new Error(`Murmur returned HTTP ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(body);
  }
  const data: string | undefined = body
    .split("\n")
    .filter((line: string): boolean => line.startsWith("data: "))
    .at(-1);
  if (data === undefined) throw new Error("Murmur returned an empty MCP event stream");
  return JSON.parse(data.slice("data: ".length));
}

async function post(
  url: string,
  token: string,
  sessionId: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(url, {
    body: JSON.stringify(body),
    headers: headers(token, sessionId),
    method: "POST",
  });
}

async function initialize(url: string, token: string, name: string): Promise<string> {
  const response: Response = await post(url, token, null, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
      protocolVersion: LATEST_PROTOCOL_VERSION,
    },
  });
  JsonRpcEnvelopeSchema.parse(await payload(response));
  const sessionId: string | null = response.headers.get("mcp-session-id");
  if (sessionId === null) throw new Error("Murmur bootstrap initialization omitted a session ID");
  await payload(
    await post(url, token, sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  ).catch((error: unknown): void => {
    if (!(error instanceof SyntaxError)) throw error;
  });
  return sessionId;
}

async function callTool(
  url: string,
  token: string,
  sessionId: string,
  id: number,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  const envelope: z.infer<typeof JsonRpcEnvelopeSchema> = JsonRpcEnvelopeSchema.parse(
    await payload(
      await post(url, token, sessionId, {
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: argumentsValue, name },
      }),
    ),
  );
  const result: z.infer<typeof CallToolResultSchema> = CallToolResultSchema.parse(envelope.result);
  if (result.isError === true) throw new Error(`Murmur tool '${name}' failed`);
  return result.structuredContent;
}

async function main(): Promise<void> {
  const url: string = requiredEnvironment("MURMUR_BOOTSTRAP_URL");
  const bootstrapToken: string | undefined = process.env["MURMUR_BOOTSTRAP_TOKEN"];
  const operatorToken: string = requiredEnvironment("MURMUR_INITIAL_OPERATOR_TOKEN");
  const legacyToken: string = requiredEnvironment("MURMUR_LEGACY_TOKEN");
  if (!DatabaseCredentialPattern.test(legacyToken)) {
    throw new LegacyTokenFormatError();
  }
  if (bootstrapToken !== undefined && bootstrapToken !== "") {
    const bootstrapSession: string = await initialize(url, bootstrapToken, "production-bootstrap");
    const issued: z.infer<typeof IssuedOperatorTokenOutputSchema> =
      IssuedOperatorTokenOutputSchema.parse(
        await callTool(url, bootstrapToken, bootstrapSession, 2, "bootstrap_operator", {
          name: "Production operator",
          secret: operatorToken,
        }),
      );
    if (issued.token.secret !== operatorToken) {
      throw new Error("Murmur returned a different operator token than the caller supplied");
    }
  }

  const operatorSession: string = await initialize(url, operatorToken, "production-operator");
  TenantStatusOutputSchema.parse(
    await callTool(url, operatorToken, operatorSession, 3, "adopt_legacy_founding_token", {}),
  );
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    logSafeError("Murmur production bootstrap failed", error);
    process.exitCode = 1;
  });
}
