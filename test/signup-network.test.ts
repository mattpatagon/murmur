import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelfServiceRegistrationInput } from "../src/hosted/contracts.js";
import { runSignupCli, type SignupRuntime } from "../src/setup/signup.js";
import {
  createSignupNetworkRuntime,
  createSignupWorker,
  registerOrganization,
} from "../src/setup/signup-network.js";
import {
  OWNER_SECRET,
  WORKER_SECRET,
  signupOwnerFixture,
  signupWorkerFixture,
} from "./support/signup-fixtures.js";
import { signupTestService, type SignupTestService } from "./support/signup-service.js";

const INPUT: SelfServiceRegistrationInput = {
  slug: "example-org",
  display_name: "Example Organization",
  registration_secret: "r".repeat(43),
};

function argumentsFor(directory: string, endpoint: string): readonly string[] {
  return [
    "--slug",
    INPUT.slug,
    "--name",
    INPUT.display_name,
    "--credentials-directory",
    directory,
    "--url",
    endpoint,
  ];
}

test("real signup HTTP and SSE wait for human consent and return commands without secrets", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-network-"));
  const server: SignupTestService = signupTestService(signupOwnerFixture(), signupWorkerFixture());
  const waiters: { approve: ((accepted: boolean) => void) | null; prompted: (() => void) | null } =
    { approve: null, prompted: null };
  const approval: Promise<boolean> = new Promise<boolean>(
    (resolve: (accepted: boolean) => void): void => {
      waiters.approve = resolve;
    },
  );
  const prompted: Promise<void> = new Promise<void>((resolve: () => void): void => {
    waiters.prompted = resolve;
  });
  const operations: SignupRuntime = createSignupNetworkRuntime(
    async (message: string): Promise<boolean> => {
      expect(message).toContain("role agent");
      if (waiters.prompted === null) throw new Error("Prompt waiter is absent");
      waiters.prompted();
      return await approval;
    },
  );
  try {
    const pending: Promise<string> = runSignupCli(argumentsFor(directory, server.endpoint), {
      interactive: true,
      operations,
      platform: "linux",
    });
    await prompted;
    expect(server.issued()).toBe(0);
    expect(existsSync(join(directory, "owner.json"))).toBe(true);
    expect(existsSync(join(directory, "worker.json"))).toBe(false);
    if (waiters.approve === null) throw new Error("Approval waiter is absent");
    waiters.approve(true);
    const output: string = await pending;
    expect(server.issued()).toBe(1);
    expect(server.registrations()).toBe(1);
    expect(output).toContain("export MURMUR_API_TOKEN=");
    expect(output).toContain("murmur setup --user");
    expect(output).not.toContain(OWNER_SECRET);
    expect(output).not.toContain(WORKER_SECRET);
    const windowsOutput: string = await runSignupCli(argumentsFor(directory, server.endpoint), {
      interactive: true,
      operations,
      platform: "win32",
    });
    expect(windowsOutput).toContain("$env:MURMUR_API_TOKEN = (");
    expect(server.issued()).toBe(1);
  } finally {
    if (waiters.approve !== null) waiters.approve(false);
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("declined signup approval preserves owner recovery and fixed-safe CLI failures", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-decline-"));
  const server: SignupTestService = signupTestService(signupOwnerFixture(), signupWorkerFixture());
  try {
    await expect(
      runSignupCli(argumentsFor(directory, server.endpoint), {
        interactive: true,
        operations: createSignupNetworkRuntime(async (): Promise<boolean> => false),
        platform: process.platform,
      }),
    ).rejects.toThrow("Signup did not complete");
    expect(server.issued()).toBe(0);
    expect(readFileSync(join(directory, "owner.json"), "utf8")).toContain(OWNER_SECRET);
    expect(existsSync(join(directory, "worker.json"))).toBe(false);
    await expect(
      createSignupWorker(server.endpoint, WORKER_SECRET, async (): Promise<boolean> => true),
    ).rejects.toThrow("Worker credential was not confirmed");
  } finally {
    await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("registration rejects invalid media, lengths, JSON, UTF-8, status and stream overflow safely", async (): Promise<void> => {
  const responses: Response[] = [
    new Response("private upstream detail", { status: 409 }),
    new Response("{}", { status: 201, headers: { "content-type": "text/plain" } }),
    new Response(null, { status: 201, headers: { "content-type": "application/json" } }),
    new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json", "content-length": "16385" },
    }),
    new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json", "content-length": "invalid" },
    }),
    new Response("private bad json", {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([255]), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
    new Response("x".repeat(16_385), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ];
  for (const response of responses) {
    await expect(
      registerOrganization(
        "https://murmur.example/mcp",
        INPUT,
        async (url: URL, init: RequestInit): Promise<Response> => {
          expect(url.pathname).toBe("/v1/tenants");
          expect(init.method).toBe("POST");
          expect(init.redirect).toBe("error");
          expect(init.signal).toBeInstanceOf(AbortSignal);
          expect(JSON.parse(typeof init.body === "string" ? init.body : "null")).toEqual(INPUT);
          return response;
        },
      ),
    ).rejects.toThrow(
      "Organization registration failed; saved registration details preserve retries",
    );
  }
  await expect(
    registerOrganization("https://murmur.example/mcp", INPUT, async (): Promise<Response> => {
      throw new Error(OWNER_SECRET);
    }),
  ).rejects.toThrow(
    "Organization registration failed; saved registration details preserve retries",
  );
  const response: unknown = await registerOrganization(
    "https://murmur.example/mcp",
    INPUT,
    async (): Promise<Response> =>
      new Response(JSON.stringify(signupOwnerFixture()), {
        status: 201,
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      }),
  );
  expect(response).toEqual(signupOwnerFixture());
});
