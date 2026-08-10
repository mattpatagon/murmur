import { z } from "zod";

import type { E2eeEntitlementState } from "../e2ee/wire-tools.js";

const E2eeEntitlementRecordSchema: z.ZodType<E2eeEntitlementRecord> = z
  .strictObject({
    plaintextWritesBlocked: z.boolean(),
    retainedCiphertextMessages: z.number().int().nonnegative().safe(),
    state: z.enum(["enforced", "off", "provisioning"]),
    trustPolicyVersion: z.number().int().positive().safe().nullable(),
    unreadPlaintextMessages: z.number().int().nonnegative().safe(),
  })
  .superRefine((record: E2eeEntitlementRecord, context: z.core.$RefinementCtx): void => {
    if (record.state === "off" && record.plaintextWritesBlocked) {
      context.addIssue({ code: "custom", message: "Off E2E state cannot block plaintext writes" });
    }
    if (
      record.state === "enforced" &&
      (!record.plaintextWritesBlocked ||
        record.trustPolicyVersion === null ||
        record.unreadPlaintextMessages !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Enforced E2E state is incomplete" });
    }
  });

export const E2EE_CAPABILITY_TOOL_NAME: string = "get_e2ee_capability";
export const TENANT_METADATA_TOOL_NAMES: readonly string[] = [
  "close_agent",
  "end_session",
  "get_agent",
  "list_agents",
  "register_agent",
];
export const PLAINTEXT_WRITE_TOOL_NAMES: readonly string[] = [
  "broadcast_message",
  "post_notice",
  "resolve_notice",
  "send_message",
  "withdraw_notice",
];
export const PLAINTEXT_READ_TOOL_NAMES: readonly string[] = [
  "get_message_history",
  "get_messages",
  "list_notices",
  "mark_messages_read",
  "wait_for_messages",
];
export const E2EE_KEY_PROVISIONING_TOOL_NAMES: readonly string[] = ["publish_agent_key_bundle"];
export const E2EE_ENFORCED_TOOL_NAMES: readonly string[] = [
  "cancel_encrypted_broadcast",
  "claim_encryption_prekey",
  "commit_encrypted_broadcast",
  "get_encrypted_messages",
  "get_inbox_summary",
  "mark_messages_read",
  "prepare_encrypted_broadcast",
  "publish_agent_key_bundle",
  "put_encrypted_broadcast_delivery",
  "put_encrypted_message",
  "wait_for_encrypted_messages",
];

export type E2eeEntitlementRecord = {
  readonly plaintextWritesBlocked: boolean;
  readonly retainedCiphertextMessages: number;
  readonly state: E2eeEntitlementState;
  readonly trustPolicyVersion: number | null;
  readonly unreadPlaintextMessages: number;
};

export function parseE2eeEntitlementRecord(input: unknown): E2eeEntitlementRecord {
  return E2eeEntitlementRecordSchema.parse(input);
}

function withState(
  current: E2eeEntitlementRecord,
  state: E2eeEntitlementState,
  plaintextWritesBlocked: boolean,
): E2eeEntitlementRecord {
  return parseE2eeEntitlementRecord({ ...current, plaintextWritesBlocked, state });
}

export function beginE2eeProvisioning(current: E2eeEntitlementRecord): E2eeEntitlementRecord {
  if (current.state !== "off") throw new Error("E2E provisioning requires the off state");
  return withState(current, "provisioning", false);
}

export function blockPlaintextWrites(current: E2eeEntitlementRecord): E2eeEntitlementRecord {
  if (current.state !== "provisioning") {
    throw new Error("Plaintext cutover requires the provisioning state");
  }
  return withState(current, "provisioning", true);
}

export function completeE2eeEnforcement(current: E2eeEntitlementRecord): E2eeEntitlementRecord {
  if (current.state !== "provisioning") {
    throw new Error("E2E enforcement requires the provisioning state");
  }
  if (!current.plaintextWritesBlocked) {
    throw new Error("E2E enforcement requires plaintext writes to be blocked");
  }
  if (current.unreadPlaintextMessages !== 0) {
    throw new Error("E2E enforcement requires the plaintext backlog to be drained");
  }
  if (current.trustPolicyVersion === null) {
    throw new Error("E2E enforcement requires a tenant trust policy");
  }
  return withState(current, "enforced", true);
}

export function rollbackE2eeToOff(current: E2eeEntitlementRecord): E2eeEntitlementRecord {
  if (current.state === "off") return current;
  if (current.retainedCiphertextMessages !== 0) {
    throw new Error("E2E rollback is unavailable while ciphertext is retained");
  }
  return withState(current, "off", false);
}

export function tenantDataToolNames(record: E2eeEntitlementRecord): readonly string[] {
  const names: Set<string> = new Set<string>([
    ...TENANT_METADATA_TOOL_NAMES,
    E2EE_CAPABILITY_TOOL_NAME,
  ]);
  if (record.state === "off") {
    for (const name of [...PLAINTEXT_READ_TOOL_NAMES, ...PLAINTEXT_WRITE_TOOL_NAMES]) {
      names.add(name);
    }
  }
  if (record.state === "provisioning") {
    for (const name of E2EE_KEY_PROVISIONING_TOOL_NAMES) names.add(name);
    for (const name of PLAINTEXT_READ_TOOL_NAMES) names.add(name);
    if (!record.plaintextWritesBlocked) {
      for (const name of PLAINTEXT_WRITE_TOOL_NAMES) names.add(name);
    }
  }
  if (record.state === "enforced") {
    for (const name of E2EE_ENFORCED_TOOL_NAMES) names.add(name);
  }
  return [...names].sort((left: string, right: string): number => left.localeCompare(right));
}
