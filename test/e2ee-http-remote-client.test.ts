import { expect, test } from "bun:test";

import {
  E2eeHttpRemoteClient,
  type E2eeHttpRemoteClientConfig,
  type E2eeWireToolCaller,
} from "../src/e2ee/http-remote-client.js";
import {
  ENCRYPTION_CLAIM_EXPIRED_MESSAGE,
  EncryptionClaimExpiredError,
} from "../src/e2ee/remote-client.js";
import type {
  E2eeCapabilityOutput,
  WaitForEncryptedMessagesOutput,
} from "../src/e2ee/wire-tools.js";

const TENANT_ID: string = "11111111-1111-4111-8111-111111111111";
const CONFIG: E2eeHttpRemoteClientConfig = {
  branch: "feature/e2ee",
  client: "codex",
  endpoint: "http://127.0.0.1:1/mcp",
  repository: "mattpatagon/murmur",
  token: "test-access-token",
};
const CAPABILITY: E2eeCapabilityOutput = {
  max_ciphertext_bytes: 524_304,
  max_one_time_prekeys: 20,
  protocol: "murmur-e2ee-v1",
  state: "enforced",
  tenant_id: TENANT_ID,
  wire_version: 1,
};

type RecordedCall = {
  readonly input: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly timeoutMs: number;
};

class FakeCaller implements E2eeWireToolCaller {
  public readonly calls: RecordedCall[] = [];
  public closeCount: number = 0;
  public response: unknown;
  public thrown: unknown = null;

  public constructor(response: unknown) {
    this.response = response;
  }

  public async call(
    name: string,
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<unknown> {
    this.calls.push({ input, name, timeoutMs });
    if (this.thrown !== null) throw this.thrown;
    return this.response;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function toolOutput(output: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify(output), type: "text" }],
    structuredContent: output,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ text: JSON.stringify({ error: message }, null, 2), type: "text" }],
    isError: true,
  };
}

test("validates remote outputs and applies absolute request deadlines", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolOutput(CAPABILITY));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  expect(await client.capability()).toEqual(CAPABILITY);
  expect(caller.calls).toEqual([{ input: {}, name: "get_e2ee_capability", timeoutMs: 30_000 }]);

  const waitOutput: WaitForEncryptedMessagesOutput = {
    agent_id: "alice",
    messages: [],
    timed_out: true,
  };
  caller.response = toolOutput(waitOutput);
  expect(
    await client.waitForEncryptedMessages({
      after_sequence: 12,
      agent_id: "alice",
      timeout_seconds: 7,
    }),
  ).toEqual(waitOutput);
  expect(caller.calls[1]).toEqual({
    input: { after_sequence: 12, agent_id: "alice", timeout_seconds: 7 },
    name: "wait_for_encrypted_messages",
    timeoutMs: 12_000,
  });
});

test("translates untrusted failures without exposing upstream details", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller({ malformed: "secret-body" });
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service returned an invalid response",
  );

  caller.response = toolError("database URL postgres://secret");
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service rejected the request",
  );

  caller.thrown = new Error("Authorization: Bearer secret-token");
  await expect(client.capability()).rejects.toThrow("The encrypted Murmur service request failed");
});

test("recognizes only the exact safe prekey-expiry response", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolError(ENCRYPTION_CLAIM_EXPIRED_MESSAGE));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await expect(client.capability()).rejects.toBeInstanceOf(EncryptionClaimExpiredError);

  caller.response = toolError(`${ENCRYPTION_CLAIM_EXPIRED_MESSAGE}.`);
  await expect(client.capability()).rejects.toThrow(
    "The encrypted Murmur service rejected the request",
  );
});

test("closes idempotently and rejects calls after shutdown", async (): Promise<void> => {
  const caller: FakeCaller = new FakeCaller(toolOutput(CAPABILITY));
  const client: E2eeHttpRemoteClient = new E2eeHttpRemoteClient(caller);
  await client.close();
  await client.close();
  expect(caller.closeCount).toBe(1);
  await expect(client.capability()).rejects.toThrow("remote client is closed");
});

test("connects over bounded Streamable HTTP with authenticated project context", async (): Promise<void> => {
  const requests: Request[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    fetch: async (request: Request): Promise<Response> => {
      requests.push(request.clone());
      const input: unknown = await request.json();
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      const method: unknown = Reflect.get(input, "method");
      const id: unknown = Reflect.get(input, "id");
      if (method === "initialize" && (typeof id === "number" || typeof id === "string")) {
        return Response.json(
          {
            id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "test-murmur", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": "bounded-session" } },
        );
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/call" && (typeof id === "number" || typeof id === "string")) {
        const result: Record<string, unknown> = toolOutput(CAPABILITY);
        const event: string = `event: message\ndata: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`;
        return new Response(event, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "unexpected" }, { status: 400 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const client: E2eeHttpRemoteClient = await E2eeHttpRemoteClient.connect({
    ...CONFIG,
    endpoint: `http://127.0.0.1:${server.port}/mcp`,
  });
  try {
    expect(await client.capability()).toEqual(CAPABILITY);
    expect(requests).toHaveLength(3);
    const callRequest: Request | undefined = requests[2];
    if (callRequest === undefined) throw new Error("Tool request was not captured");
    const callHeaders: Headers = callRequest.headers;
    expect(callHeaders.get("authorization")).toBe("Bearer test-access-token");
    expect(callHeaders.get("x-murmur-repository")).toBe("mattpatagon/murmur");
    expect(callHeaders.get("x-murmur-branch")).toBe("feature/e2ee");
    expect(callHeaders.get("x-murmur-client")).toBe("codex");
    expect(callHeaders.get("mcp-session-id")).toBe("bounded-session");
    expect(callHeaders.get("mcp-protocol-version")).toBe("2025-11-25");
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("rejects insecure external endpoints and unsafe configuration before connecting", async (): Promise<void> => {
  await expect(
    E2eeHttpRemoteClient.connect({ ...CONFIG, endpoint: "http://example.com/mcp" }),
  ).rejects.toThrow("must use HTTPS outside loopback");
  await expect(
    E2eeHttpRemoteClient.connect({ ...CONFIG, endpoint: "https://user@example.com/mcp" }),
  ).rejects.toThrow("may not contain credentials or parameters");
  await expect(E2eeHttpRemoteClient.connect({ ...CONFIG, token: "bad token" })).rejects.toThrow(
    "access token is invalid",
  );
});
