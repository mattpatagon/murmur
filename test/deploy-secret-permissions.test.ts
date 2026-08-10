import { expect, test } from "bun:test";

import {
  type DeploySecretPermissionOptions,
  verifyDeploySecretPermissions,
} from "../scripts/verify-deploy-secret-permissions.js";

function secretName(input: string | URL | Request): string {
  const url: URL = new URL(String(input));
  const match: RegExpMatchArray | null =
    url.origin === "https://secretmanager.googleapis.com"
      ? url.pathname.match(
          /^\/v1\/projects\/test-project\/secrets\/([^:]+)(?::testIamPermissions)?$/,
        )
      : null;
  if (match === null || match[1] === undefined) {
    throw new Error(`Unexpected permission probe URL: ${url.href}`);
  }
  return decodeURIComponent(match[1]);
}

function assertGoogleRequest(input: string | URL | Request, init: RequestInit | undefined): void {
  secretName(input);
  if (init === undefined) {
    throw new Error("Google request options are required");
  }
  const headers: Headers = new Headers(init.headers);
  const permissionProbe: boolean = isPermissionProbe(input);
  if (
    headers.get("Authorization") !== "Bearer test-access-token" ||
    (permissionProbe &&
      (init.method !== "POST" || headers.get("Content-Type") !== "application/json")) ||
    (!permissionProbe && (init.method !== "GET" || init.body !== undefined))
  ) {
    throw new Error("Request does not match the Google Secret Manager REST contract");
  }
}

function permissionRequest(init: RequestInit | undefined): string[] {
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("Permission probe must have a JSON string body");
  }
  const parsed: unknown = JSON.parse(init.body);
  const permissions: unknown =
    parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "permissions") : undefined;
  if (
    !Array.isArray(permissions) ||
    !permissions.every((value: unknown): boolean => typeof value === "string")
  ) {
    throw new Error("Permission probe body must contain string permissions");
  }
  return permissions;
}

function isPermissionProbe(input: string | URL | Request): boolean {
  return new URL(String(input)).pathname.endsWith(":testIamPermissions");
}

function options(
  fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]>,
  legacySecretValueRequired: boolean = true,
): DeploySecretPermissionOptions {
  return {
    accessToken: "test-access-token",
    fetcher,
    legacySecretValueRequired,
    projectId: "test-project",
  };
}

interface GoogleFetcherOptions {
  metadataStatus?: (secretName: string) => number;
  permissions?: (secretName: string, requestedPermissions: string[]) => string[];
}

function googleFetcher(
  fakeOptions: GoogleFetcherOptions = {},
): NonNullable<DeploySecretPermissionOptions["fetcher"]> {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assertGoogleRequest(input, init);
    const requestedSecret: string = secretName(input);
    if (!isPermissionProbe(input)) {
      const status: number =
        fakeOptions.metadataStatus === undefined
          ? 200
          : fakeOptions.metadataStatus(requestedSecret);
      return status === 200
        ? Response.json({ name: `projects/test-project/secrets/${requestedSecret}` })
        : new Response(null, { status });
    }
    const requestedPermissions: string[] = permissionRequest(init);
    const permissions: string[] =
      fakeOptions.permissions === undefined
        ? requestedPermissions
        : fakeOptions.permissions(requestedSecret, requestedPermissions);
    return Response.json({ permissions });
  };
}

async function expectMetadataError(secret: string, status: number, error: string): Promise<void> {
  const fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]> = googleFetcher({
    metadataStatus: (candidate: string): number => (candidate === secret ? status : 200),
  });
  await expect(verifyDeploySecretPermissions(options(fetcher))).rejects.toThrow(error);
}

test("deploy preflight requires every permission before migrations", async (): Promise<void> => {
  const requestedSecrets: string[] = [];
  const fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]> = googleFetcher({
    permissions: (secret: string, requested: string[]): string[] => {
      requestedSecrets.push(secret);
      return requested;
    },
  });

  await expect(verifyDeploySecretPermissions(options(fetcher))).resolves.toEqual({
    legacySecretExists: true,
  });
  expect(requestedSecrets).toEqual([
    "MURMUR_CI_DATABASE_URL",
    "MURMUR_DATABASE_CA",
    "MURMUR_DATABASE_URL",
    "MURMUR_OPERATOR_TOKEN",
    "MURMUR_API_TOKEN",
  ]);
});

test("deploy preflight reports the exact missing secret permission", async (): Promise<void> => {
  const fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]> = googleFetcher({
    permissions: (secret: string, requested: string[]): string[] =>
      secret === "MURMUR_DATABASE_URL"
        ? requested.filter(
            (permission: string): boolean => permission !== "secretmanager.versions.list",
          )
        : requested,
  });

  await expect(verifyDeploySecretPermissions(options(fetcher))).rejects.toThrow(
    "Missing Secret Manager permissions for MURMUR_DATABASE_URL: secretmanager.versions.list",
  );
});

test("deploy preflight requires the operator secret to be pre-created", async (): Promise<void> =>
  expectMetadataError(
    "MURMUR_OPERATOR_TOKEN",
    404,
    "MURMUR_OPERATOR_TOKEN must exist before the deployment starts",
  ));

test("deploy preflight requires the legacy secret until adoption", async (): Promise<void> =>
  expectMetadataError(
    "MURMUR_API_TOKEN",
    404,
    "MURMUR_API_TOKEN must exist until legacy adoption is complete",
  ));

test("strict redeploy permits a deleted legacy secret", async (): Promise<void> => {
  const requestedSecrets: string[] = [];
  const fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]> = googleFetcher({
    metadataStatus: (secret: string): number => (secret === "MURMUR_API_TOKEN" ? 404 : 200),
    permissions: (secret: string, requested: string[]): string[] => {
      requestedSecrets.push(secret);
      return requested;
    },
  });
  await expect(verifyDeploySecretPermissions(options(fetcher, false))).resolves.toEqual({
    legacySecretExists: false,
  });
  expect(requestedSecrets).not.toContain("MURMUR_API_TOKEN");
});

test("strict redeploy requires revocation permissions while the legacy secret exists", async (): Promise<void> => {
  const fetcher: NonNullable<DeploySecretPermissionOptions["fetcher"]> = googleFetcher({
    permissions: (secret: string, requested: string[]): string[] =>
      secret === "MURMUR_API_TOKEN"
        ? requested.filter(
            (permission: string): boolean => permission !== "secretmanager.secrets.setIamPolicy",
          )
        : requested,
  });
  await expect(verifyDeploySecretPermissions(options(fetcher, false))).rejects.toThrow(
    "Missing Secret Manager permissions for MURMUR_API_TOKEN: secretmanager.secrets.setIamPolicy",
  );
});

test("deploy preflight fails closed on a denied secret metadata read", async (): Promise<void> =>
  expectMetadataError(
    "MURMUR_OPERATOR_TOKEN",
    403,
    "Secret Manager could not read MURMUR_OPERATOR_TOKEN (HTTP 403)",
  ));

test("workflow performs authoritative secret reads before applying migrations", async (): Promise<void> => {
  const workflow: string = await Bun.file(".github/workflows/deploy.yml").text();
  const orderedMarkers: string[] = [
    "Validate Secret Manager rollout permissions",
    "gcloud secrets versions list MURMUR_DATABASE_URL",
    "gcloud secrets get-iam-policy MURMUR_API_TOKEN",
    "--secret MURMUR_API_TOKEN",
    "--secret MURMUR_OPERATOR_TOKEN",
    "Apply migrations and verify shared Postgres",
  ];
  let previousPosition: number = -1;
  for (const marker of orderedMarkers) {
    const position: number = workflow.indexOf(marker, previousPosition + 1);
    expect(position).toBeGreaterThan(previousPosition);
    previousPosition = position;
  }
});

test("workflow resumes runtime credentials through the reachable admin database", async (): Promise<void> => {
  const workflow: string = await Bun.file(".github/workflows/deploy.yml").text();
  expect(workflow).not.toContain('psql "$candidate_url"');
  const inspectPosition: number = workflow.indexOf("MURMUR_RUNTIME_DATABASE_URL_TO_INSPECT");
  const buildPosition: number = workflow.indexOf("Build production image", inspectPosition);
  const pushPosition: number = workflow.indexOf("Push production image", buildPosition);
  const compatibilityPosition: number = workflow.indexOf(
    "Deploy compatibility revision before runtime credential rotation",
    pushPosition,
  );
  const recoverPosition: number = workflow.indexOf(
    "Recover staged runtime database credential",
    compatibilityPosition,
  );
  const applyPosition: number = workflow.indexOf(
    "MURMUR_RUNTIME_DATABASE_CREDENTIAL_URL",
    recoverPosition,
  );
  const deployPosition: number = workflow.indexOf("Deploy Cloud Run revision", applyPosition);
  expect(inspectPosition).toBeGreaterThan(-1);
  expect(buildPosition).toBeGreaterThan(inspectPosition);
  expect(pushPosition).toBeGreaterThan(buildPosition);
  expect(compatibilityPosition).toBeGreaterThan(pushPosition);
  expect(recoverPosition).toBeGreaterThan(compatibilityPosition);
  expect(applyPosition).toBeGreaterThan(recoverPosition);
  expect(deployPosition).toBeGreaterThan(applyPosition);
});

test("production smoke masks privileged credentials before live isolation checks", async (): Promise<void> => {
  const workflow: string = await Bun.file(".github/workflows/production-smoke.yml").text();
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).not.toContain("pull_request:");
  expect(workflow).not.toContain("push:");
  const operatorReadPosition: number = workflow.indexOf("--secret MURMUR_OPERATOR_TOKEN");
  const operatorMaskPosition: number = workflow.indexOf('echo "::add-mask::$operator_token"');
  const verificationPosition: number = workflow.indexOf("bun scripts/verify-production-hosted.ts");
  expect(operatorReadPosition).toBeGreaterThan(-1);
  expect(operatorMaskPosition).toBeGreaterThan(operatorReadPosition);
  expect(verificationPosition).toBeGreaterThan(operatorMaskPosition);
  expect(workflow).not.toContain("MURMUR_API_TOKEN");
  expect(workflow).not.toContain("MURMUR_LIVE_FOUNDING_TOKEN");
});

test("workflows pin every GitHub Action to an immutable commit", async (): Promise<void> => {
  const workflowPaths: readonly string[] = [
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yml",
    ".github/workflows/production-smoke.yml",
  ];
  for (const workflowPath of workflowPaths) {
    const workflow: string = await Bun.file(workflowPath).text();
    const actionUses: readonly string[] = workflow
      .split("\n")
      .filter((line: string): boolean => /^\s*uses:/u.test(line));
    expect(actionUses.length).toBeGreaterThan(0);
    actionUses.forEach((line: string): void => {
      expect(line).toMatch(/^\s*uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s+#\s+v\d+)?\s*$/u);
    });
  }
});
