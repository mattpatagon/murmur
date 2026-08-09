#!/usr/bin/env bun

import process from "node:process";

import { logSafeError } from "../src/safe-errors.js";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const RequiredPermissions: Readonly<Record<string, readonly string[]>> = Object.freeze({
  MURMUR_CI_DATABASE_URL: ["secretmanager.versions.access"],
  MURMUR_DATABASE_CA: ["secretmanager.versions.access"],
  MURMUR_DATABASE_URL: [
    "secretmanager.versions.access",
    "secretmanager.versions.add",
    "secretmanager.versions.disable",
    "secretmanager.versions.list",
  ],
  MURMUR_OPERATOR_TOKEN: [
    "secretmanager.secrets.get",
    "secretmanager.versions.access",
    "secretmanager.versions.add",
  ],
});

const LegacySecretPolicyPermissions: readonly string[] = Object.freeze([
  "secretmanager.secrets.get",
  "secretmanager.secrets.getIamPolicy",
  "secretmanager.secrets.setIamPolicy",
]);

export interface DeploySecretPermissionOptions {
  accessToken: string;
  fetcher?: Fetcher;
  legacySecretValueRequired: boolean;
  projectId: string;
}

async function verifySecretPermissions(
  secretName: string,
  requiredPermissions: readonly string[],
  options: DeploySecretPermissionOptions,
): Promise<void> {
  // Google documents testIamPermissions as a UI/CLI diagnostic that may fail open.
  // The rollout's real Secret Manager operations must remain fail-closed.
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const resource: string = `projects/${encodeURIComponent(options.projectId)}/secrets/${encodeURIComponent(secretName)}`;
  const response: Response = await fetcher(
    `https://secretmanager.googleapis.com/v1/${resource}:testIamPermissions`,
    {
      body: JSON.stringify({ permissions: requiredPermissions }),
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(`Secret Manager could not inspect ${secretName} (HTTP ${response.status})`);
  }
  const payload: unknown = await response.json();
  const permissionValues: unknown =
    payload !== null && typeof payload === "object"
      ? Reflect.get(payload, "permissions")
      : undefined;
  const grantedPermissions: Set<string> = new Set(
    Array.isArray(permissionValues)
      ? permissionValues.filter((value: unknown): value is string => typeof value === "string")
      : [],
  );
  const missingPermissions: string[] = requiredPermissions.filter(
    (permission: string): boolean => !grantedPermissions.has(permission),
  );
  if (missingPermissions.length > 0) {
    throw new Error(
      `Missing Secret Manager permissions for ${secretName}: ${missingPermissions.join(", ")}`,
    );
  }
}

async function requireSecretExists(
  secretName: string,
  options: DeploySecretPermissionOptions,
): Promise<boolean> {
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const resource: string = `projects/${encodeURIComponent(options.projectId)}/secrets/${encodeURIComponent(secretName)}`;
  const response: Response = await fetcher(`https://secretmanager.googleapis.com/v1/${resource}`, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    method: "GET",
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Secret Manager could not read ${secretName} (HTTP ${response.status})`);
  }
  return true;
}

export async function verifyDeploySecretPermissions(
  options: DeploySecretPermissionOptions,
): Promise<{ legacySecretExists: boolean }> {
  if (options.projectId === "") {
    throw new Error("PROJECT_ID is required");
  }
  if (options.accessToken === "") {
    throw new Error("A Google Cloud access token is required");
  }
  if (!(await requireSecretExists("MURMUR_OPERATOR_TOKEN", options))) {
    throw new Error("MURMUR_OPERATOR_TOKEN must exist before the deployment starts");
  }
  for (const [secretName, permissions] of Object.entries(RequiredPermissions)) {
    await verifySecretPermissions(secretName, permissions, options);
  }
  const legacySecretExists: boolean = await requireSecretExists("MURMUR_API_TOKEN", options);
  if (!legacySecretExists) {
    if (options.legacySecretValueRequired) {
      throw new Error("MURMUR_API_TOKEN must exist until legacy adoption is complete");
    }
    return { legacySecretExists: false };
  }
  const legacyPermissions: readonly string[] = options.legacySecretValueRequired
    ? [...LegacySecretPolicyPermissions, "secretmanager.versions.access"]
    : LegacySecretPolicyPermissions;
  await verifySecretPermissions("MURMUR_API_TOKEN", legacyPermissions, options);
  return { legacySecretExists: true };
}

function accessToken(): string {
  const result: Bun.ReadableSyncSubprocess = Bun.spawnSync(
    ["gcloud", "auth", "print-access-token"],
    { stderr: "pipe", stdout: "pipe" },
  );
  const token: string = result.stdout.toString().trim();
  if (result.exitCode !== 0 || token === "") {
    throw new Error("Google Cloud authentication is unavailable");
  }
  return token;
}

async function main(): Promise<void> {
  const projectId: string = process.env["PROJECT_ID"] ?? "";
  const legacySecretValueRequired: boolean =
    process.env["MURMUR_LEGACY_SECRET_VALUE_REQUIRED"] !== "0";
  const result: { legacySecretExists: boolean } = await verifyDeploySecretPermissions({
    accessToken: accessToken(),
    legacySecretValueRequired,
    projectId,
  });
  process.stdout.write(`${result.legacySecretExists ? "true" : "false"}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error: unknown) {
    logSafeError("Murmur deploy Secret Manager preflight failed", error);
    process.exitCode = 1;
  }
}
