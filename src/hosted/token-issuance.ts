import { randomUUID } from "node:crypto";

import { PersonalId } from "../domain/orchestration.js";
import type { AgentId, Instant, RepositoryName, TenantId } from "../domain/value-objects.js";
import type {
  IssuedOperatorToken,
  IssuedToken,
  TenantTokenRole,
} from "./control-plane-contracts.js";
import {
  generateTokenSecret,
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
