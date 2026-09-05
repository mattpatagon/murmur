import type { CreateTenantOutput, IssuedTokenOutput } from "../../src/hosted/contracts.js";

export const TENANT_ID: string = "41000000-0000-4000-8000-000000000001";
export const OTHER_TENANT_ID: string = "41000000-0000-4000-8000-000000000002";
export const OWNER_SECRET: string = `mur_owner001_${"a".repeat(43)}`;
export const WORKER_SECRET: string = `mur_worker01_${"b".repeat(43)}`;

export function signupOwnerFixture(): CreateTenantOutput {
  return {
    tenant: {
      created_at: "2026-09-04T00:00:00.000Z",
      display_name: "Example Organization",
      slug: "example-org",
      status: "active",
      suspended_at: null,
      tenant_id: TENANT_ID,
    },
    token: {
      agent_id: null,
      expires_at: null,
      key_id: "owner001",
      name: "Initial administrator",
      personal_id: "42000000-0000-4000-8000-000000000001",
      repository: null,
      role: "tenant_admin",
      secret: OWNER_SECRET,
      tenant_id: TENANT_ID,
      token_id: "43000000-0000-4000-8000-000000000001",
    },
  };
}

export function signupWorkerFixture(): IssuedTokenOutput {
  return {
    token: {
      ...signupOwnerFixture().token,
      key_id: "worker01",
      name: "Everyday agent",
      role: "agent",
      secret: WORKER_SECRET,
      token_id: "43000000-0000-4000-8000-000000000002",
    },
  };
}
