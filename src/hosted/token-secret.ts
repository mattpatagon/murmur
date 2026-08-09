import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

const KEY_ID_PATTERN: string = "[A-Za-z0-9_-]{8,32}";
const SECRET_MATERIAL_PATTERN: string = "[A-Za-z0-9_-]{43}";
const TENANT_TOKEN_SECRET_PATTERN: RegExp = new RegExp(
  `^mur_(${KEY_ID_PATTERN})_${SECRET_MATERIAL_PATTERN}$`,
  "u",
);
const OPERATOR_TOKEN_SECRET_PATTERN: RegExp = new RegExp(
  `^mur_op_(${KEY_ID_PATTERN})_${SECRET_MATERIAL_PATTERN}$`,
  "u",
);
const BOOTSTRAP_TOKEN_SECRET_PATTERN: RegExp = new RegExp(
  `^mur_boot_(${KEY_ID_PATTERN})_${SECRET_MATERIAL_PATTERN}$`,
  "u",
);
const LEGACY_TOKEN_SECRET_PATTERN: RegExp = /^[a-f0-9]{64}$/u;

export type DatabaseCredentialHint = {
  readonly keyId: string;
  readonly principalKind: "bootstrap" | "operator" | "tenant";
};

export type HostedTokenPrefix = "mur" | "mur_op";

export type HostedTokenSecret = {
  readonly hash: Buffer;
  readonly keyId: string;
  readonly secret: string;
};

export const TenantTokenSecretSchema: z.ZodString = z.string().regex(TENANT_TOKEN_SECRET_PATTERN);

export const OperatorTokenSecretSchema: z.ZodString = z
  .string()
  .regex(OPERATOR_TOKEN_SECRET_PATTERN);

export const DatabaseCredentialPattern: RegExp = new RegExp(
  `^(?:(?:mur_${KEY_ID_PATTERN}|mur_op_${KEY_ID_PATTERN}|mur_boot_${KEY_ID_PATTERN})_${SECRET_MATERIAL_PATTERN}|[a-f0-9]{64})$`,
  "u",
);

export function hashTokenSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function credentialAdmissionKey(value: string): string {
  return createHash("sha256").update(hashTokenSecret(value)).digest("hex");
}

export function databaseCredentialHint(value: string): DatabaseCredentialHint | null {
  const operatorMatch: RegExpExecArray | null = OPERATOR_TOKEN_SECRET_PATTERN.exec(value);
  if (operatorMatch !== null && operatorMatch[1] !== undefined) {
    return { keyId: operatorMatch[1], principalKind: "operator" };
  }
  const bootstrapMatch: RegExpExecArray | null = BOOTSTRAP_TOKEN_SECRET_PATTERN.exec(value);
  if (bootstrapMatch !== null && bootstrapMatch[1] !== undefined) {
    return { keyId: bootstrapMatch[1], principalKind: "bootstrap" };
  }
  const tenantMatch: RegExpExecArray | null = TENANT_TOKEN_SECRET_PATTERN.exec(value);
  if (tenantMatch !== null && tenantMatch[1] !== undefined) {
    return { keyId: tenantMatch[1], principalKind: "tenant" };
  }
  if (LEGACY_TOKEN_SECRET_PATTERN.test(value)) {
    return {
      keyId: `legacy_${hashTokenSecret(value).toString("base64url").slice(0, 12)}`,
      principalKind: "tenant",
    };
  }
  return null;
}

export function generateTokenSecret(prefix: HostedTokenPrefix): HostedTokenSecret {
  const keyId: string = randomBytes(6).toString("base64url");
  const secret: string = `${prefix}_${keyId}_${randomBytes(32).toString("base64url")}`;
  return { hash: hashTokenSecret(secret), keyId, secret };
}

export function parseOperatorTokenSecret(secret: string): HostedTokenSecret {
  OperatorTokenSecretSchema.parse(secret);
  const match: RegExpExecArray | null = OPERATOR_TOKEN_SECRET_PATTERN.exec(secret);
  const keyId: string | undefined = match === null ? undefined : match[1];
  if (keyId === undefined) throw new Error("Invalid operator token secret");
  return { hash: hashTokenSecret(secret), keyId, secret };
}
