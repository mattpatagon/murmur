import { expect, spyOn, test } from "bun:test";
import {
  type RegisterAgentInput,
  RegisterAgentInputSchema,
} from "../src/domain/agent-contracts.js";
import type { JsonObject, JsonValue } from "../src/domain/value-objects.js";
import type {
  AgentKeyRevocationDto,
  PrekeyCertificateDto,
  PublicAgentSigningChainDto,
} from "../src/e2ee/wire-contracts.js";
import {
  type PublishAgentKeyBundleInput,
  PublishAgentKeyBundleInputSchema,
  type PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryInputSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
} from "../src/e2ee/wire-tools.js";
import { parseBoundedJsonText } from "../src/http/bounded-json.js";
import { parseRequestBody } from "../src/http/http-request.js";
import { readPublicSetupBody } from "../src/http/public-setup-body.js";
import {
  createTenantRegistrationHandler,
  type TenantRegistrationService,
} from "../src/http/self-service-registration.js";
import {
  finalizeFixtureDeliveries,
  finalizeSenderChain,
} from "./support/e2ee-broadcast-finalize-fixture.js";
import {
  PublicSetupTestTime,
  publicSetupHarness,
  type SetupHarness,
  setupRequest,
} from "./support/public-setup-harness.js";

function bodyRequest(text: string): Request {
  return new Request("http://localhost/mcp", {
    body: text,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

const DEEP_REQUEST: string =
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent",' +
  '"arguments":{"agent_id":"fixture","metadata":{"value":' +
  "[".repeat(40) +
  "0" +
  "]".repeat(40) +
  "}}}}";

test("MCP and registration reject tiny deeply nested text before native JSON parsing", async (): Promise<void> => {
  expect(Buffer.byteLength(DEEP_REQUEST, "utf8")).toBeLessThan(300);
  expect(JSON.stringify(JSON.parse(DEEP_REQUEST))).toBe(DEEP_REQUEST);
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  const nativeParse: ReturnType<typeof spyOn<typeof JSON, "parse">> = spyOn(JSON, "parse");
  try {
    await expect(parseRequestBody(bodyRequest(DEEP_REQUEST), 4096, time)).rejects.toThrow(
      "The MCP request body must be valid JSON",
    );
    expect(nativeParse).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    nativeParse.mockRestore();
  }
});

test("anonymous setup rejects tiny deeply nested text before native JSON parsing", async (): Promise<void> => {
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  const nativeParse: ReturnType<typeof spyOn<typeof JSON, "parse">> = spyOn(JSON, "parse");
  try {
    await expect(readPublicSetupBody(bodyRequest(DEEP_REQUEST), 5000, time)).rejects.toThrow();
    expect(nativeParse).not.toHaveBeenCalled();
    expect(time.pending()).toBe(0);
  } finally {
    nativeParse.mockRestore();
  }
});

test("container depth 32 is inclusive for arrays, objects and mixed nesting", (): void => {
  for (const kind of ["arrays", "objects", "mixed"]) {
    let text: string = "0";
    for (let index: number = 0; index < 32; index += 1) {
      text =
        kind === "objects" || (kind === "mixed" && index % 2 === 0)
          ? `{"value":${text}}`
          : `[${text}]`;
    }
    expect(JSON.stringify(parseBoundedJsonText(text))).toBe(text);
    expect((): unknown => parseBoundedJsonText(`[${text}]`)).toThrow(
      "Request JSON exceeds its structural limits",
    );
  }
});

test("structural units bound wide arrays and repeated object keys before native parsing", async (): Promise<void> => {
  const boundary: string = `[${"0,".repeat(16_382)}0]`;
  const parsed: unknown = parseBoundedJsonText(boundary);
  expect(Array.isArray(parsed)).toBe(true);
  if (!Array.isArray(parsed)) throw new Error("Expected an array");
  expect(parsed.length).toBe(16_383);
  for (const text of [`[${"0,".repeat(16_383)}0]`, `{${'"":0,'.repeat(8191)}"":0}`]) {
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_048_576);
    const nativeParse: ReturnType<typeof spyOn<typeof JSON, "parse">> = spyOn(JSON, "parse");
    try {
      await expect(parseRequestBody(bodyRequest(text), 1_048_576)).rejects.toThrow(
        "The MCP request body must be valid JSON",
      );
      expect(nativeParse).not.toHaveBeenCalled();
    } finally {
      nativeParse.mockRestore();
    }
  }
});

test("quoted punctuation, escaped backslashes and quotes do not consume structure units", async (): Promise<void> => {
  const values: readonly unknown[] = [
    null,
    true,
    false,
    -1200,
    "",
    [],
    {},
    { value: '[{:]},"\\'.repeat(3000), unicode: "雪🍃" },
    { "\\": "\\\\", '"': '\\"', "[]": [":,", { "{}": "[]" }] },
  ];
  for (const value of values) {
    const text: string = JSON.stringify(value);
    expect(parseBoundedJsonText(` \r\n\t${text} `)).toEqual(value);
  }
  const escapedUnicode: string = String.raw`{"\u005b":"\u005d","quote":"\"","slash":"\\"}`;
  expect(parseBoundedJsonText(escapedUnicode)).toEqual({ "[": "]", quote: '"', slash: "\\" });
  const time: PublicSetupTestTime = new PublicSetupTestTime();
  const text: string = JSON.stringify({ value: "[{:]},".repeat(1000) });
  expect(await readPublicSetupBody(bodyRequest(text), 5000, time)).toEqual(JSON.parse(text));
  expect(time.pending()).toBe(0);
});

test("native JSON grammar validation remains authoritative for structurally small input", (): void => {
  for (const text of [
    "",
    "[}",
    "{]",
    "[0,]",
    "{}{}",
    "[",
    '"unfinished',
    String.raw`"bad\q"`,
    "01",
    "NaN",
  ]) {
    expect((): unknown => parseBoundedJsonText(text)).toThrow();
  }
  expect((): unknown => parseBoundedJsonText("]")).toThrow(
    "Request JSON exceeds its structural limits",
  );
});

test("anonymous setup structural rejection is fixed, redacted and releases public capacity", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  try {
    const response: Response = await fixture.handle(bodyRequest(DEEP_REQUEST));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Setup body must be valid JSON within 8192 bytes and its deadline",
    });
    expect(fixture.time.pending()).toBe(0);
    const release: (() => void) | null = fixture.capacity.reservePublicRequest("next-request");
    expect(release).not.toBeNull();
    if (release === null) throw new Error("Setup capacity did not recover");
    release();
    const recovered: Response = await fixture.handle(setupRequest());
    expect(recovered.status).toBe(200);
    await recovered.arrayBuffer();
  } finally {
    await fixture.observability.shutdown();
  }
});

test("registration structural rejection avoids the service and keeps response-lifetime capacity", async (): Promise<void> => {
  const fixture: SetupHarness = publicSetupHarness();
  let calls: number = 0;
  const handler: ReturnType<typeof createTenantRegistrationHandler> =
    createTenantRegistrationHandler({
      allowedOrigins: new Set<string>(),
      capacity: fixture.capacity,
      maxRequestBytes: 1_048_576,
      rateLimitPerMinute: 1,
      registration: (): ReturnType<TenantRegistrationService> => {
        calls += 1;
        throw new Error("Registration service must not be called");
      },
    });
  const reserveRemaining: (() => void) | null = fixture.capacity.reserveRequest("other", null);
  if (reserveRemaining === null) throw new Error("Missing initial request capacity");
  try {
    const request: Request = bodyRequest(DEEP_REQUEST);
    const response: Response = await handler(request, fixture.observability.observe(request));
    expect(response.status).toBe(400);
    expect(fixture.capacity.reserveRequest("next-request", null)).toBeNull();
    expect(await response.json()).toEqual({ error: "Tenant registration body must be valid JSON" });
    expect(calls).toBe(0);
    const release: (() => void) | null = fixture.capacity.reserveRequest("next-request", null);
    expect(release).not.toBeNull();
    if (release === null) throw new Error("Registration capacity did not recover");
    release();
    expect(fixture.capacity.rateLimitAllows("public-tenant-registration", 1)).toBe(true);
  } finally {
    reserveRemaining();
    await fixture.observability.shutdown();
  }
});

function toolRequest(name: string, argumentsValue: unknown): string {
  return JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: argumentsValue },
  });
}

test("structural limits accept maximum-byte dense metadata and maximum valid metadata depth", (): void => {
  const candidates: JsonObject[] = [{ one: { two: { three: { four: 0 } } } }];
  for (const values of [
    Array.from({ length: 80 }, (): number[] => Array.from({ length: 100 }, (): number => 0)),
    Array.from({ length: 80 }, (): JsonValue[][] =>
      Array.from({ length: 65 }, (): JsonValue[] => []),
    ),
  ]) {
    const dense: JsonObject = { values, padding: "" };
    const metadata: JsonObject = {
      ...dense,
      padding: "x".repeat(16_384 - Buffer.byteLength(JSON.stringify(dense), "utf8")),
    };
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBe(16_384);
    candidates.push(metadata);
  }
  for (const candidate of candidates) {
    const input: RegisterAgentInput = RegisterAgentInputSchema.parse({
      agent_id: "fixture",
      metadata: candidate,
    });
    const text: string = toolRequest("register_agent", input);
    expect(JSON.stringify(parseBoundedJsonText(text))).toBe(text);
  }
});

test("structural limits accept a wire-valid bundle with 100 prekeys and 100 revocations", (): void => {
  const chain: PublicAgentSigningChainDto = finalizeSenderChain();
  const prekey: PrekeyCertificateDto = {
    agent_id: chain.agent_certificate.agent_id,
    agent_signing_key_id: chain.agent_certificate.signing_key_id,
    created_at: chain.agent_certificate.created_at,
    expires_at: chain.agent_certificate.expires_at,
    prekey_class: "fallback",
    prekey_id: `mpk_${"z".repeat(43)}`,
    prekey_public_key: "a".repeat(43),
    signature: "a".repeat(86),
  };
  const input: PublishAgentKeyBundleInput = PublishAgentKeyBundleInputSchema.parse({
    agent_id: chain.agent_certificate.agent_id,
    bundle: {
      ...chain,
      agent_key_revocations: Array.from(
        { length: 100 },
        (_unused: unknown, index: number): AgentKeyRevocationDto => ({
          agent_id: chain.agent_certificate.agent_id,
          reason: "r".repeat(500),
          revoked_at: chain.agent_certificate.created_at,
          revoked_signing_key_id: `mak_${String(index).padStart(43, "0")}`,
          root_key_id: chain.root_key_id,
          signature: "a".repeat(86),
        }),
      ),
      fallback_prekey: prekey,
      one_time_prekeys: Array.from(
        { length: 100 },
        (_unused: unknown, index: number): PrekeyCertificateDto => ({
          ...prekey,
          prekey_class: "one_time",
          prekey_id: `mpk_${String(index).padStart(43, "0")}`,
        }),
      ),
    },
  });
  const text: string = toolRequest("publish_agent_key_bundle", input);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_048_576);
  expect(JSON.stringify(parseBoundedJsonText(text))).toBe(text);
});

test("structural limits accept maximum ciphertext direct and staged broadcast request schemas", (): void => {
  const broadcastId: string = "44000000-0000-4000-8000-000000000001";
  const [delivery]: ReturnType<typeof finalizeFixtureDeliveries> = finalizeFixtureDeliveries(
    broadcastId,
    1,
    undefined,
    512 * 1024,
  );
  if (delivery === undefined) throw new Error("Missing envelope fixture");
  const broadcast: PutEncryptedBroadcastDeliveryInput =
    PutEncryptedBroadcastDeliveryInputSchema.parse({
      broadcast_id: broadcastId,
      claim_id: delivery.claimId,
      envelope: delivery.envelope,
    });
  const direct: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse({
    claim_id: delivery.claimId,
    envelope: { ...delivery.envelope, header: { ...delivery.envelope.header, broadcast_id: null } },
  });
  for (const { name, input } of [
    { name: "put_encrypted_message", input: direct },
    { name: "put_encrypted_broadcast_delivery", input: broadcast },
  ]) {
    const text: string = toolRequest(name, input);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_048_576);
    expect(JSON.stringify(parseBoundedJsonText(text))).toBe(text);
  }
});
