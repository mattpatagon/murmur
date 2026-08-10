import { expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { encryptedWireToolDefinitions } from "../src/e2ee/wire-tool-definitions.js";
import {
  beginE2eeProvisioning,
  blockPlaintextWrites,
  completeE2eeEnforcement,
  type E2eeEntitlementRecord,
  parseE2eeEntitlementRecord,
  rollbackE2eeToOff,
  tenantDataToolNames,
} from "../src/hosted/e2ee-entitlement.js";

function entitlement(
  state: E2eeEntitlementRecord["state"],
  overrides: Partial<E2eeEntitlementRecord> = {},
): E2eeEntitlementRecord {
  return parseE2eeEntitlementRecord({
    plaintextWritesBlocked: state === "enforced",
    retainedCiphertextMessages: 0,
    state,
    trustPolicyVersion: state === "enforced" ? 1 : null,
    unreadPlaintextMessages: 0,
    ...overrides,
  });
}

test("validates stored entitlement invariants at the database boundary", (): void => {
  expect(
    (): E2eeEntitlementRecord =>
      parseE2eeEntitlementRecord({
        plaintextWritesBlocked: true,
        retainedCiphertextMessages: 0,
        state: "off",
        trustPolicyVersion: null,
        unreadPlaintextMessages: 0,
      }),
  ).toThrow("cannot block plaintext writes");
  expect(
    (): E2eeEntitlementRecord =>
      parseE2eeEntitlementRecord({
        plaintextWritesBlocked: true,
        retainedCiphertextMessages: 1,
        state: "enforced",
        trustPolicyVersion: 1,
        unreadPlaintextMessages: 1,
      }),
  ).toThrow("incomplete");
  expect(
    (): E2eeEntitlementRecord =>
      parseE2eeEntitlementRecord({
        plaintextWritesBlocked: false,
        retainedCiphertextMessages: -1,
        state: "off",
        trustPolicyVersion: null,
        unreadPlaintextMessages: 0,
      }),
  ).toThrow();
});

test("cuts over only after blocking writes, draining backlog, and installing trust", (): void => {
  const provisioning: E2eeEntitlementRecord = beginE2eeProvisioning(entitlement("off"));
  expect(provisioning).toMatchObject({ plaintextWritesBlocked: false, state: "provisioning" });
  expect((): E2eeEntitlementRecord => completeE2eeEnforcement(provisioning)).toThrow(
    "plaintext writes",
  );
  const blocked: E2eeEntitlementRecord = blockPlaintextWrites({
    ...provisioning,
    trustPolicyVersion: 3,
    unreadPlaintextMessages: 2,
  });
  expect((): E2eeEntitlementRecord => completeE2eeEnforcement(blocked)).toThrow(
    "backlog to be drained",
  );
  const enforced: E2eeEntitlementRecord = completeE2eeEnforcement({
    ...blocked,
    unreadPlaintextMessages: 0,
  });
  expect(enforced).toMatchObject({
    plaintextWritesBlocked: true,
    state: "enforced",
    trustPolicyVersion: 3,
  });
});

test("rejects rollback while any ciphertext remains retained", (): void => {
  const retained: E2eeEntitlementRecord = entitlement("enforced", {
    retainedCiphertextMessages: 1,
  });
  expect((): E2eeEntitlementRecord => rollbackE2eeToOff(retained)).toThrow(
    "while ciphertext is retained",
  );
  expect(rollbackE2eeToOff({ ...retained, retainedCiphertextMessages: 0 })).toMatchObject({
    plaintextWritesBlocked: false,
    state: "off",
  });
});

test("exposes the exact off, provisioning, cutover, and enforced tool matrices", (): void => {
  const off: readonly string[] = tenantDataToolNames(entitlement("off"));
  expect(off).toEqual([
    "broadcast_message",
    "close_agent",
    "end_session",
    "get_agent",
    "get_e2ee_capability",
    "get_message_history",
    "get_messages",
    "list_agents",
    "list_notices",
    "mark_messages_read",
    "post_notice",
    "register_agent",
    "resolve_notice",
    "send_message",
    "wait_for_messages",
    "withdraw_notice",
  ]);
  const provisioning: E2eeEntitlementRecord = entitlement("provisioning");
  expect(tenantDataToolNames(provisioning)).toEqual([
    ...off.slice(0, 11),
    "publish_agent_key_bundle",
    ...off.slice(11),
  ]);
  expect(tenantDataToolNames(blockPlaintextWrites(provisioning))).toEqual([
    "close_agent",
    "end_session",
    "get_agent",
    "get_e2ee_capability",
    "get_message_history",
    "get_messages",
    "list_agents",
    "list_notices",
    "mark_messages_read",
    "publish_agent_key_bundle",
    "register_agent",
    "wait_for_messages",
  ]);
  const enforcedNames: readonly string[] = tenantDataToolNames(entitlement("enforced"));
  const encryptedNames: readonly string[] = encryptedWireToolDefinitions().map(
    (tool: Tool): string => tool.name,
  );
  expect(new Set(enforcedNames)).toEqual(
    new Set<string>([
      ...encryptedNames,
      "close_agent",
      "end_session",
      "get_agent",
      "list_agents",
      "register_agent",
    ]),
  );
  expect(enforcedNames).not.toContain("send_message");
  expect(enforcedNames).not.toContain("broadcast_message");
  expect(enforcedNames).not.toContain("get_messages");
  expect(enforcedNames).not.toContain("wait_for_messages");
});
