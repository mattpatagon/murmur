import { createHash, randomUUID } from "node:crypto";

import { PersonalId } from "../domain/orchestration.js";
import {
  type AgentId,
  type Instant,
  type RepositoryName,
  TenantId,
} from "../domain/value-objects.js";
import type {
  IssuedOperatorToken,
  IssuedToken,
  TenantTokenRole,
} from "./control-plane-contracts.js";
import {
  generateTokenSecret,
  deriveRegistrationTokenSecret,
  type HostedTokenPrefix,
  type HostedTokenSecret,
  parseOperatorTokenSecret,
} from "./token-secret.js";

export type IssuedTokenMaterial = { readonly hash: Buffer; readonly token: IssuedToken };
export type IssuedOperatorTokenMaterial = {
  readonly hash: Buffer;
  readonly token: IssuedOperatorToken;
};

function issueSecret(prefix: HostedTokenPrefix): {
  readonly hash: Buffer;
  readonly keyId: string;
  readonly secret: string;
  readonly tokenId: string;
} {
  return { ...generateTokenSecret(prefix), tokenId: randomUUID() };
}

export function issueToken(
  tenantId: TenantId,
  role: TenantTokenRole,
  name: string,
  expiresAt: Instant | null,
  personalId: PersonalId | null,
  repositoryName: RepositoryName | null,
  agentId: AgentId | null,
): IssuedTokenMaterial {
  const issued: ReturnType<typeof issueSecret> = issueSecret("mur");
  const selectedPersonalId: PersonalId = personalId ?? PersonalId.parse(issued.tokenId);
  return {
    hash: issued.hash,
    token: {
      agentId,
      expiresAt,
      keyId: issued.keyId,
      name,
      personalId: selectedPersonalId,
      repositoryName,
      role,
      secret: issued.secret,
      tenantId,
      tokenId: issued.tokenId,
    },
  };
}

function registrationUuid(scope: "tenant" | "token", registrationSecret: string): string {
  const hex: string = createHash("sha256")
    .update(`murmur-registration-${scope}\0`, "utf8")
    .update(registrationSecret, "utf8")
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function selfServiceTenantId(registrationSecret: string): TenantId {
  return TenantId.parse(registrationUuid("tenant", registrationSecret));
}

export function issueSelfServiceToken(
  tenantId: TenantId,
  registrationSecret: string,
): IssuedTokenMaterial {
  const issued: HostedTokenSecret = deriveRegistrationTokenSecret(registrationSecret);
  const tokenId: string = registrationUuid("token", registrationSecret);
  return {
    hash: issued.hash,
    token: {
      agentId: null,
      expiresAt: null,
      keyId: issued.keyId,
      name: "Initial tenant administrator",
      personalId: PersonalId.parse(tokenId),
      repositoryName: null,
      role: "tenant_admin",
      secret: issued.secret,
      tenantId,
      tokenId,
    },
  };
}

export function issueOperatorToken(
  name: string,
  expiresAt: Instant | null,
): IssuedOperatorTokenMaterial {
  const issued: ReturnType<typeof issueSecret> = issueSecret("mur_op");
  return {
    hash: issued.hash,
    token: {
      expiresAt,
      keyId: issued.keyId,
      name,
      secret: issued.secret,
      tokenId: issued.tokenId,
    },
  };
}

export function providedOperatorToken(name: string, secret: string): IssuedOperatorTokenMaterial {
  const parsed: HostedTokenSecret = parseOperatorTokenSecret(secret);
  return {
    hash: parsed.hash,
    token: {
      expiresAt: null,
      keyId: parsed.keyId,
      name,
      secret,
      tokenId: randomUUID(),
    },
  };
}
