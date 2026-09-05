import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateTenantOutput,
  IssuedTokenOutput,
  SelfServiceRegistrationInput,
} from "../src/hosted/contracts.js";
import {
  parseSignupArguments,
  runSignupCli,
  type SignupOptions,
  type SignupResult,
  type SignupRuntime,
  signupOrganization,
} from "../src/setup/signup.js";

import {
  OTHER_TENANT_ID,
  OWNER_SECRET,
  signupOwnerFixture,
  signupWorkerFixture,
  TENANT_ID,
  WORKER_SECRET,
} from "./support/signup-fixtures.js";

function options(directory: string): SignupOptions {
  return {
    directory,
    displayName: "Example Organization",
    endpoint: "https://murmur.example/mcp",
    slug: "example-org",
  };
}

function runtime(): SignupRuntime {
  return {
    createWorker: async (): Promise<unknown> => signupWorkerFixture(),
    register: async (): Promise<unknown> => signupOwnerFixture(),
  };
}

test("signup configuration keeps credentials on the validated custom service in each shell", async (): Promise<void> => {
  const endpoints: readonly string[] = [
    "https://MURMUR.example:443/mcp",
    "https://MURMUR.example:443/mcp'custom",
  ];
  const platforms: readonly NodeJS.Platform[] = ["linux", "win32"];
  for (const platform of platforms) {
    for (const endpoint of endpoints) {
      const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-custom-"));
      try {
        const normalized: string = new URL(endpoint).toString();
        const output: string = await runSignupCli(
          [
            "--slug",
            "example-org",
            "--name",
            "Example Organization",
            "--url",
            endpoint,
            "--credentials-directory",
            directory,
          ],
          {
            interactive: true,
            platform,
            operations: {
              register: async (url: string): Promise<unknown> => {
                expect(url).toBe(normalized);
                return signupOwnerFixture();
              },
              createWorker: async (url: string): Promise<unknown> => {
                expect(url).toBe(normalized);
                return signupWorkerFixture();
              },
            },
          },
        );
        const expectedCommand: string =
          platform === "win32"
            ? endpoint.endsWith("custom")
              ? "murmur setup --user --url 'https://murmur.example/mcp''custom'"
              : "murmur setup --user --url 'https://murmur.example/mcp'"
            : endpoint.endsWith("custom")
              ? "murmur setup --user --url 'https://murmur.example/mcp'\"'\"'custom'"
              : "murmur setup --user --url https://murmur.example/mcp";
        expect(output).toContain(expectedCommand);
        expect(output).not.toContain("api.usemurmur.dev");
        expect(output).not.toContain(OWNER_SECRET);
        expect(output).not.toContain(WORKER_SECRET);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  }
});

test("signup keeps owner and worker credentials private, separate, and durable across reruns", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-"));
  let registrations: number = 0;
  let workers: number = 0;
  const calls: SignupRuntime = {
    register: async (endpoint: string, input: SelfServiceRegistrationInput): Promise<unknown> => {
      registrations += 1;
      expect(endpoint).toBe("https://murmur.example/mcp");
      expect(input.registration_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return signupOwnerFixture();
    },
    createWorker: async (endpoint: string, token: string): Promise<unknown> => {
      workers += 1;
      expect(endpoint).toBe("https://murmur.example/mcp");
      expect(token).toBe(OWNER_SECRET);
      return signupWorkerFixture();
    },
  };
  try {
    const first: SignupResult = await signupOrganization(options(directory), calls);
    expect(first.tenantId).toBe(TENANT_ID);
    expect(JSON.stringify(first)).not.toContain(OWNER_SECRET);
    expect(JSON.stringify(first)).not.toContain(WORKER_SECRET);
    expect(readFileSync(first.ownerFile, "utf8")).toContain(OWNER_SECRET);
    expect(readFileSync(first.workerFile, "utf8")).toContain(WORKER_SECRET);
    expect(readFileSync(first.workerFile, "utf8")).not.toContain(OWNER_SECRET);
    expect(await signupOrganization(options(directory), calls)).toEqual(first);
    expect({ registrations, workers }).toEqual({ registrations: 1, workers: 1 });
    if (process.platform !== "win32") {
      for (const file of [
        first.ownerFile,
        first.workerFile,
        join(directory, "registration.json"),
      ]) {
        expect(lstatSync(file).mode & 0o077).toBe(0);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a lost registration response retries the exact saved high-entropy registration", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-retry-"));
  const attempts: SelfServiceRegistrationInput[] = [];
  const calls: SignupRuntime = {
    ...runtime(),
    register: async (_endpoint: string, input: SelfServiceRegistrationInput): Promise<unknown> => {
      attempts.push(input);
      if (attempts.length === 1) throw new Error("simulated lost response");
      return signupOwnerFixture();
    },
  };
  try {
    await expect(signupOrganization(options(directory), calls)).rejects.toThrow("lost response");
    expect(existsSync(join(directory, "registration.json"))).toBe(true);
    expect(existsSync(join(directory, "owner.json"))).toBe(false);
    await signupOrganization(options(directory), calls);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("worker failure preserves the owner credential and resumes without registering again", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-worker-"));
  let registrations: number = 0;
  let workers: number = 0;
  const calls: SignupRuntime = {
    register: async (): Promise<unknown> => {
      registrations += 1;
      return signupOwnerFixture();
    },
    createWorker: async (): Promise<unknown> => {
      workers += 1;
      if (workers === 1) throw new Error("worker issuance unavailable");
      return signupWorkerFixture();
    },
  };
  try {
    await expect(signupOrganization(options(directory), calls)).rejects.toThrow(
      "issuance unavailable",
    );
    expect(readFileSync(join(directory, "owner.json"), "utf8")).toContain(OWNER_SECRET);
    expect(existsSync(join(directory, "worker.json"))).toBe(false);
    await signupOrganization(options(directory), calls);
    expect({ registrations, workers }).toEqual({ registrations: 1, workers: 2 });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("signup rejects server responses with the wrong tenant, organization, or credential role", async (): Promise<void> => {
  const invalidOwners: CreateTenantOutput[] = [
    { ...signupOwnerFixture(), tenant: { ...signupOwnerFixture().tenant, slug: "other-org" } },
    {
      ...signupOwnerFixture(),
      token: { ...signupOwnerFixture().token, tenant_id: OTHER_TENANT_ID },
    },
    { ...signupOwnerFixture(), token: { ...signupOwnerFixture().token, role: "agent" } },
  ];
  for (const invalid of invalidOwners) {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-owner-invalid-"));
    try {
      await expect(
        signupOrganization(options(directory), {
          ...runtime(),
          register: async (): Promise<unknown> => invalid,
        }),
      ).rejects.toThrow("unexpected tenant");
      expect(existsSync(join(directory, "owner.json"))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
  const invalidWorkers: IssuedTokenOutput[] = [
    { token: { ...signupWorkerFixture().token, tenant_id: OTHER_TENANT_ID } },
    { token: { ...signupWorkerFixture().token, role: "tenant_admin" } },
  ];
  for (const invalid of invalidWorkers) {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-worker-invalid-"));
    try {
      await expect(
        signupOrganization(options(directory), {
          ...runtime(),
          createWorker: async (): Promise<unknown> => invalid,
        }),
      ).rejects.toThrow("unexpected worker");
      expect(existsSync(join(directory, "owner.json"))).toBe(true);
      expect(existsSync(join(directory, "worker.json"))).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("signup validates options, private paths, and retained checkpoint ownership before network work", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-validation-"));
  try {
    expect((): SignupOptions => parseSignupArguments([])).toThrow("requires");
    expect(
      (): SignupOptions => parseSignupArguments(["--slug", "../escape", "--name", "Name"]),
    ).toThrow();
    expect(
      (): SignupOptions => parseSignupArguments(["--slug", "example-org", "--slug", "another-org"]),
    ).toThrow("Usage");
    expect((): SignupOptions => parseSignupArguments(["--unknown", "value"])).toThrow("Usage");
    expect((): SignupOptions => parseSignupArguments(["--slug"])).toThrow("Usage");
    expect(
      parseSignupArguments([
        "--slug",
        "example-org",
        "--name",
        "Name",
        "--credentials-directory",
        directory,
      ]).directory,
    ).toBe(directory);
    await expect(
      signupOrganization({ ...options(directory), directory: "relative" }, runtime()),
    ).rejects.toThrow("absolute");
    await expect(
      signupOrganization(
        { ...options(directory), endpoint: "http://remote.example/mcp" },
        runtime(),
      ),
    ).rejects.toThrow();
    await signupOrganization(options(directory), runtime());
    await expect(
      signupOrganization({ ...options(directory), displayName: "Different" }, runtime()),
    ).rejects.toThrow("different organization");
    writeFileSync(join(directory, "worker.json"), "x".repeat(16_385));
    await expect(signupOrganization(options(directory), runtime())).rejects.toThrow(
      "bounded regular",
    );
    if (process.platform !== "win32") {
      chmodSync(directory, 0o755);
      await expect(signupOrganization(options(directory), runtime())).rejects.toThrow(
        "directory must be private",
      );
      chmodSync(directory, 0o700);
      writeFileSync(join(directory, "worker.json"), JSON.stringify(signupWorkerFixture()));
      chmodSync(join(directory, "worker.json"), 0o644);
      await expect(signupOrganization(options(directory), runtime())).rejects.toThrow(
        "only to their owner",
      );
    }
    await expect(
      runSignupCli([
        "--slug",
        "example-org",
        "--name",
        "Name",
        "--credentials-directory",
        directory,
      ]),
    ).rejects.toThrow("interactive terminal");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
