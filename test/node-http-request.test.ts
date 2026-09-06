import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";

import {
  IngressByteBudget,
  type IngressFailure,
  nodeRequestMetadata,
  StagedNodeBody,
} from "../src/http/node-http-request.js";

function input(
  rawHeaders: string[] = ["Host", "localhost:8080"],
  url: string = "/mcp",
): Pick<IncomingMessage, "method" | "url" | "rawHeaders"> {
  return { method: "POST", url, rawHeaders };
}

test("metadata preserves canonical Host/path and never trusts forwarded headers", (): void => {
  const metadata: ReturnType<typeof nodeRequestMetadata> = nodeRequestMetadata(
    input(
      ["Host", "[::1]:8080", "X-Forwarded-Host", "attacker.example", "X-Forwarded-Proto", "https"],
      "/mcp?value=1",
    ),
    1_024,
  );
  expect(metadata.url.href).toBe("http://[::1]:8080/mcp?value=1");
  expect(metadata.maximumBodyBytes).toBe(1_024);
  expect(metadata.hasBody).toBe(false);
  expect(nodeRequestMetadata(input(undefined, "//other.example/mcp"), 1_024).url.hostname).toBe(
    "localhost",
  );
  expect(nodeRequestMetadata(input(undefined, "/v1/tenants"), 10_000).maximumBodyBytes).toBe(4_096);
  expect(nodeRequestMetadata(input(undefined, "/setup/mcp"), 1_024).maximumBodyBytes).toBe(8_192);
  expect(nodeRequestMetadata(input(undefined, "/oauth/token"), 1_024).maximumBodyBytes).toBe(8_192);
});

test("ambiguous framing, metadata and oversized headers fail closed", (): void => {
  const invalid: string[][] = [
    ["Host"],
    ["Host", "a", "Host", "b"],
    ["Host", "user@host"],
    ["Host", "a", "Authorization", "Bearer a", "authorization", "Bearer b"],
    ["Host", "a", "Content-Length", "-1"],
    ["Host", "a", "Content-Length", "9007199254740992"],
    ["Host", "a", "Content-Length", "1", "Transfer-Encoding", "chunked"],
    ["Host", "a", "Transfer-Encoding", "gzip,chunked"],
    ["Host", "a", "bad header", "x"],
    ["Host", "a", "x-test", "a\rb"],
    ["Host", "a", "x-test", "a".repeat(16_384)],
  ];
  for (const headers of invalid)
    expect((): unknown => nodeRequestMetadata(input(headers), 1_024)).toThrow();
  for (const target of ["https://other.example/mcp", "/bad\\path", "/path#fragment", "/a b"]) {
    expect((): unknown => nodeRequestMetadata(input(undefined, target), 1_024)).toThrow();
  }
  expect((): unknown => nodeRequestMetadata({ ...input(), method: "TRACE" }, 1_024)).toThrow();
  expect(
    nodeRequestMetadata(input(["Host", "a", "Transfer-Encoding", "chunked"]), 1_024).hasBody,
  ).toBe(true);
});

test("unsolicited small pushes are coalesced and cannot exceed a shared allocation budget", async (): Promise<void> => {
  const budget: IngressByteBudget = new IngressByteBudget(8_192);
  const failures: IngressFailure[] = [];
  const first: StagedNodeBody = new StagedNodeBody(
    budget,
    16_384,
    (failure: IngressFailure): void => {
      failures.push(failure);
    },
  );
  const second: StagedNodeBody = new StagedNodeBody(
    budget,
    16_384,
    (failure: IngressFailure): void => {
      failures.push(failure);
    },
  );
  const request: Request = new Request("http://localhost/mcp", {
    method: "POST",
    body: first.body,
  });
  for (let index: number = 0; index < 4_096; index += 1) first.push(new Uint8Array([97]));
  second.push(new Uint8Array(4_096));
  expect(budget.reservedBytes).toBe(8_192);
  expect(request.bodyUsed).toBe(false);
  first.push(new Uint8Array([98]));
  expect(failures).toEqual(["capacity"]);
  expect(first.rejection).toBe("capacity");
  expect(budget.reservedBytes).toBe(4_096);
  first.push(new Uint8Array(32_768));
  expect(budget.reservedBytes).toBe(4_096);
  second.stop();
  first.stop();
  expect(budget.reservedBytes).toBe(0);
});

test("staging preserves bytes through demand and cancellation independently of native pause", async (): Promise<void> => {
  const budget: IngressByteBudget = new IngressByteBudget(8_192);
  const inputBody: StagedNodeBody = new StagedNodeBody(budget, 8_192, (): void => {
    throw new Error("Unexpected rejection");
  });
  const request: Request = new Request("http://localhost/mcp", {
    method: "POST",
    body: inputBody.body,
  });
  inputBody.push(new Uint8Array());
  inputBody.push(new Uint8Array(5_000).fill(97));
  inputBody.end();
  expect(budget.reservedBytes).toBe(8_192);
  expect(await request.text()).toBe("a".repeat(5_000));
  expect(budget.reservedBytes).toBe(0);
  const cancelled: StagedNodeBody = new StagedNodeBody(budget, 4_096, (): void => undefined);
  cancelled.push(new Uint8Array(8));
  await cancelled.body.cancel();
  cancelled.stop();
  cancelled.push(new Uint8Array(8));
  expect(budget.reservedBytes).toBe(0);
});

test("invalid and cumulative oversized ingress errors once and releases allocations", async (): Promise<void> => {
  const budget: IngressByteBudget = new IngressByteBudget(4_096);
  const failures: IngressFailure[] = [];
  const bounded: StagedNodeBody = new StagedNodeBody(budget, 2, (failure: IngressFailure): void => {
    failures.push(failure);
  });
  bounded.push(new Uint8Array(2));
  bounded.push(new Uint8Array(1));
  bounded.push("bad");
  expect(failures).toEqual(["too_large"]);
  expect(budget.reservedBytes).toBe(0);
  const invalid: StagedNodeBody = new StagedNodeBody(budget, 2, (failure: IngressFailure): void => {
    failures.push(failure);
  });
  invalid.push("bad");
  expect(invalid.rejection).toBe("invalid");
  expect((): IngressByteBudget => new IngressByteBudget(0)).toThrow();
  expect((): StagedNodeBody => new StagedNodeBody(budget, -1, (): void => undefined)).toThrow();
});
