import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { parseDatabaseUrl } from "../database-url.js";
import { TenantId } from "../domain/value-objects.js";
import { postgresTlsConfiguration } from "../postgres-tls.js";
import {
  PostgresHostedControlPlane,
  type CredentialAdmission,
  type HostedControlPlane,
  type HostedPrincipal,
} from "./control-plane.js";
import {
  credentialAdmissionKey,
  DatabaseCredentialPattern,
  hashTokenSecret,
} from "./token-secret.js";

type AuthMode = "hybrid" | "legacy" | "multi-tenant";

export class HostedAuthenticator {
  public readonly allowBootstrap: boolean;
  public readonly controlPlane: HostedControlPlane | null;
  public readonly tenantOnboardingEnabled: boolean;
  private readonly legacyToken: string | null;
  private readonly mode: AuthMode;

  public constructor(options: {
    readonly allowBootstrap: boolean;
    readonly controlPlane: HostedControlPlane | null;
    readonly legacyToken: string | null;
    readonly mode: AuthMode;
    readonly tenantOnboardingEnabled: boolean;
  }) {
    this.allowBootstrap = options.allowBootstrap;
    this.controlPlane = options.controlPlane;
    this.legacyToken = options.legacyToken;
    this.mode = options.mode;
    this.tenantOnboardingEnabled = options.tenantOnboardingEnabled;
  }

  public async authenticate(token: string): Promise<HostedPrincipal | null> {
    const presentedHash: Buffer = hashTokenSecret(token);
    if (this.mode !== "multi-tenant" && this.legacyToken !== null) {
      const expectedHash: Buffer = hashTokenSecret(this.legacyToken);
      if (timingSafeEqual(presentedHash, expectedHash)) {
        return {
          kind: "tenant",
          role: "tenant_admin",
          tenantId: TenantId.founding(),
          tokenId: "legacy",
        };
      }
    }
    if (
      this.controlPlane === null ||
      this.mode === "legacy" ||
      !DatabaseCredentialPattern.test(token)
    ) {
      return null;
    }
    return await this.controlPlane.authenticate(token);
  }

  public credentialAdmission(token: string): CredentialAdmission | null {
    const presentedHash: Buffer = hashTokenSecret(token);
    if (this.mode !== "multi-tenant" && this.legacyToken !== null) {
      const expectedHash: Buffer = hashTokenSecret(this.legacyToken);
      if (timingSafeEqual(presentedHash, expectedHash)) {
        return {
          key: credentialAdmissionKey(token),
          tenantKey: credentialAdmissionKey(TenantId.founding().value),
        };
      }
    }
    return this.controlPlane === null ? null : this.controlPlane.credentialAdmission(token);
  }

  public bootstrapCredentialHash(principal: HostedPrincipal, token: string): Buffer | null {
    const allowed: boolean = this.allowBootstrap && principal.kind === "bootstrap";
    return allowed ? hashTokenSecret(token) : null;
  }

  public legacyCredentialHash(principal: HostedPrincipal): Buffer | null {
    const allowed: boolean = this.mode === "hybrid" && principal.kind === "operator";
    return allowed && this.legacyToken !== null ? hashTokenSecret(this.legacyToken) : null;
  }

  public identity(principal: HostedPrincipal): string {
    return `${principal.kind}:${principal.tokenId}`;
  }

  public async close(): Promise<void> {
    if (this.controlPlane !== null) await this.controlPlane.close();
  }
}

function authMode(environment: NodeJS.ProcessEnv): AuthMode {
  const value: string = environment["MURMUR_AUTH_MODE"] ?? "hybrid";
  return z.enum(["hybrid", "legacy", "multi-tenant"]).parse(value);
}

function bootstrapAllowed(environment: NodeJS.ProcessEnv): boolean {
  const value: string | undefined = environment["MURMUR_ALLOW_BOOTSTRAP"];
  if (value === undefined || value === "" || value === "0") return false;
  if (value !== "1") throw new Error("MURMUR_ALLOW_BOOTSTRAP must be 0 or 1");
  return true;
}

function expectedTenantContractVersion(environment: NodeJS.ProcessEnv): 1 | 2 | null {
  const value: string | undefined = environment["MURMUR_TENANT_CONTRACT_VERSION"];
  if (value === undefined || value === "") return null;
  const parsed: "1" | "2" = z.enum(["1", "2"]).parse(value);
  return parsed === "1" ? 1 : 2;
}

export async function createHostedAuthenticator(
  environment: NodeJS.ProcessEnv,
): Promise<HostedAuthenticator> {
  const mode: AuthMode = authMode(environment);
  const allowBootstrap: boolean = bootstrapAllowed(environment);
  const expectedContractVersion: 1 | 2 | null = expectedTenantContractVersion(environment);
  const legacyValue: string | undefined = environment["MURMUR_API_TOKEN"];
  const legacyToken: string | null =
    legacyValue === undefined || legacyValue.trim() === "" ? null : legacyValue;
  const databaseUrl: string | undefined = environment["MURMUR_DATABASE_URL"];
  if (allowBootstrap && mode !== "hybrid") {
    throw new Error("Operator bootstrap requires hybrid auth and Postgres hosted storage");
  }
  let controlPlane: HostedControlPlane | null = null;
  if (mode !== "legacy" && databaseUrl !== undefined && databaseUrl !== "") {
    const url: URL = parseDatabaseUrl(databaseUrl);
    if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
      controlPlane = await PostgresHostedControlPlane.connect(
        databaseUrl,
        postgresTlsConfiguration(environment),
      );
    }
  }
  try {
    if (mode === "multi-tenant" && controlPlane === null) {
      throw new Error("Multi-tenant auth requires Postgres hosted storage");
    }
    if (mode === "legacy" && legacyToken === null) {
      throw new Error("Legacy auth requires MURMUR_API_TOKEN");
    }
    if (allowBootstrap && controlPlane === null) {
      throw new Error("Operator bootstrap requires hybrid auth and Postgres hosted storage");
    }
    const hasActiveOperator: boolean =
      controlPlane === null ? false : await controlPlane.hasActiveOperator();
    const tenantOnboardingEnabled: boolean =
      controlPlane === null ? false : await controlPlane.tenantOnboardingEnabled();
    if (expectedContractVersion === 2 && !tenantOnboardingEnabled) {
      throw new Error(
        "Tenant contract version 2 is required but the database remains at version 1",
      );
    }
    if (expectedContractVersion === 1 && tenantOnboardingEnabled) {
      throw new Error("Tenant contract version 1 was requested after database finalization");
    }
    if (mode === "multi-tenant" && !hasActiveOperator) {
      throw new Error("Multi-tenant auth requires at least one active operator token");
    }
    return new HostedAuthenticator({
      allowBootstrap: allowBootstrap && !hasActiveOperator,
      controlPlane,
      legacyToken,
      mode,
      tenantOnboardingEnabled,
    });
  } catch (error: unknown) {
    if (controlPlane !== null) await controlPlane.close();
    throw error;
  }
}
