import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import { z } from "zod";
import { parseAdminArguments } from "../admin/terminal-client.js";
import {
  type CreateTenantOutput,
  CreateTenantOutputSchema,
  type IssuedTokenOutput,
  IssuedTokenOutputSchema,
  type SelfServiceRegistrationInput,
  SelfServiceRegistrationInputSchema,
} from "../hosted/contracts.js";
import { userHomeDirectory } from "../platform-paths.js";
import {
  prepareSignupDirectory,
  readSignupPrivateFile,
  saveSignupPrivateFile,
} from "./signup-files.js";
import { createSignupNetworkRuntime } from "./signup-network.js";
import { DEFAULT_MURMUR_URL, shellQuote } from "./user-configuration.js";

const OwnerRecordSchema: z.ZodType<{
  readonly endpoint: string;
  readonly registration: SelfServiceRegistrationInput;
}> = z.strictObject({
  endpoint: z.string().url(),
  registration: SelfServiceRegistrationInputSchema,
});

export type SignupOptions = {
  readonly directory: string;
  readonly displayName: string;
  readonly endpoint: string;
  readonly slug: string;
};

export type SignupRuntime = {
  readonly register: (endpoint: string, input: SelfServiceRegistrationInput) => Promise<unknown>;
  readonly createWorker: (endpoint: string, ownerToken: string) => Promise<unknown>;
};

export type SignupResult = {
  readonly endpoint: string;
  readonly ownerFile: string;
  readonly tenantId: string;
  readonly workerFile: string;
};

export async function signupOrganization(
  options: SignupOptions,
  runtime: SignupRuntime,
): Promise<SignupResult> {
  if (!isAbsolute(options.directory))
    throw new Error("Signup credentials directory must be absolute");
  const endpoint: string = parseAdminArguments(["tools", "--url", options.endpoint]).url.toString();
  const proposed: SelfServiceRegistrationInput = SelfServiceRegistrationInputSchema.parse({
    display_name: options.displayName,
    registration_secret: randomBytes(32).toString("base64url"),
    slug: options.slug,
  });
  prepareSignupDirectory(options.directory);
  const requestFile: string = join(options.directory, "registration.json");
  const ownerFile: string = join(options.directory, "owner.json");
  const workerFile: string = join(options.directory, "worker.json");
  if (!existsSync(requestFile))
    saveSignupPrivateFile(requestFile, { endpoint, registration: proposed });
  const saved: z.infer<typeof OwnerRecordSchema> = OwnerRecordSchema.parse(
    JSON.parse(readSignupPrivateFile(requestFile)),
  );
  if (
    saved.endpoint !== endpoint ||
    saved.registration.slug !== proposed.slug ||
    saved.registration.display_name !== proposed.display_name
  ) {
    throw new Error("Signup directory belongs to a different organization or endpoint");
  }
  const owner: CreateTenantOutput = existsSync(ownerFile)
    ? CreateTenantOutputSchema.parse(JSON.parse(readSignupPrivateFile(ownerFile)))
    : CreateTenantOutputSchema.parse(await runtime.register(endpoint, saved.registration));
  if (
    owner.tenant.slug !== proposed.slug ||
    owner.tenant.display_name !== proposed.display_name ||
    owner.token.tenant_id !== owner.tenant.tenant_id ||
    owner.token.role !== "tenant_admin"
  ) {
    throw new Error("Signup returned an unexpected tenant or administrator credential");
  }
  if (!existsSync(ownerFile)) saveSignupPrivateFile(ownerFile, owner);
  const worker: IssuedTokenOutput = existsSync(workerFile)
    ? IssuedTokenOutputSchema.parse(JSON.parse(readSignupPrivateFile(workerFile)))
    : IssuedTokenOutputSchema.parse(await runtime.createWorker(endpoint, owner.token.secret));
  if (worker.token.tenant_id !== owner.tenant.tenant_id || worker.token.role !== "agent") {
    throw new Error("Signup returned an unexpected worker credential");
  }
  if (!existsSync(workerFile)) saveSignupPrivateFile(workerFile, worker);
  return { endpoint, ownerFile, tenantId: owner.tenant.tenant_id, workerFile };
}

export function parseSignupArguments(arguments_: readonly string[]): SignupOptions {
  const values: Map<string, string> = new Map<string, string>();
  for (let index: number = 0; index < arguments_.length; index += 2) {
    const name: string | undefined = arguments_[index];
    const value: string | undefined = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      values.has(name) ||
      !["--slug", "--name", "--url", "--credentials-directory"].includes(name)
    ) {
      throw new Error(
        "Usage: murmur signup --slug ORGANIZATION --name NAME [--url URL] [--credentials-directory ABSOLUTE_DIRECTORY]",
      );
    }
    values.set(name, value);
  }
  const slug: string | undefined = values.get("--slug");
  const displayName: string | undefined = values.get("--name");
  if (slug === undefined || displayName === undefined)
    throw new Error("Signup requires --slug and --name");
  // Validate before using the slug in a path.
  const input: SelfServiceRegistrationInput = SelfServiceRegistrationInputSchema.parse({
    slug,
    display_name: displayName,
    registration_secret: randomBytes(32).toString("base64url"),
  });
  return {
    directory:
      values.get("--credentials-directory") ??
      join(userHomeDirectory(), ".murmur", "credentials", input.slug),
    displayName: input.display_name,
    endpoint: values.get("--url") ?? DEFAULT_MURMUR_URL,
    slug: input.slug,
  };
}

export type SignupCliRuntime = {
  readonly interactive: boolean;
  readonly operations: SignupRuntime;
  readonly platform: NodeJS.Platform;
};

export async function runSignupCli(
  arguments_: readonly string[],
  runtime: SignupCliRuntime = {
    interactive:
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true &&
      process.stderr.isTTY === true,
    operations: createSignupNetworkRuntime(),
    platform: process.platform,
  },
): Promise<string> {
  const options: SignupOptions = parseSignupArguments(arguments_);
  if (!runtime.interactive) {
    throw new Error(
      "Signup requires a user-controlled interactive terminal for approval and private credential storage",
    );
  }
  let result: SignupResult;
  try {
    result = await signupOrganization(options, runtime.operations);
  } catch (_error: unknown) {
    throw new Error(
      "Signup did not complete. Inspect the private credentials directory and retry the same command; any saved organization and owner credential are preserved.",
    );
  }
  const quotedFile: string =
    runtime.platform === "win32"
      ? `'${result.workerFile.replaceAll("'", "''")}'`
      : shellQuote(result.workerFile);
  const loadWorker: string = `bun -e 'process.stdout.write((await Bun.file(process.argv[1]).json()).token.secret)' ${quotedFile}`;
  const environmentCommand: string =
    runtime.platform === "win32"
      ? `$env:MURMUR_API_TOKEN = (${loadWorker})`
      : `export MURMUR_API_TOKEN="$(${loadWorker})"`;
  const quotedEndpoint: string =
    runtime.platform === "win32"
      ? `'${result.endpoint.replaceAll("'", "''")}'`
      : shellQuote(result.endpoint);
  return `Organization ready: ${result.tenantId}\nOwner credential: ${result.ownerFile}\nWorker credential: ${result.workerFile}\n\nMove the owner credential and registration recovery file into your private secret store outside worker access. Keep only the worker credential in the agent environment. In this private terminal run:\n${environmentCommand}\nmurmur setup --user --url ${quotedEndpoint}\n\nRestart your agent and ask it to call get_setup_guide. No credential values were printed.\n`;
}
