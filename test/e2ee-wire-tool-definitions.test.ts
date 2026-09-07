import { expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { encryptedWireToolDefinitions } from "../src/e2ee/wire-tool-definitions.js";

test("exposes only bounded public-key and ciphertext wire tools", (): void => {
  const tools: readonly Tool[] = encryptedWireToolDefinitions();
  expect(tools.map((tool: Tool): string => tool.name)).toEqual([
    "get_e2ee_capability",
    "publish_agent_key_bundle",
    "claim_encryption_prekey",
    "claim_orchestrator_prekey",
    "put_encrypted_message",
    "get_encrypted_messages",
    "wait_for_encrypted_messages",
    "acknowledge_encrypted_messages",
    "mark_messages_read",
    "prepare_encrypted_broadcast",
    "put_encrypted_broadcast_delivery",
    "commit_encrypted_broadcast",
    "cancel_encrypted_broadcast",
    "get_inbox_summary",
  ]);
  const serialized: string = JSON.stringify(tools);
  expect(serialized).not.toContain('"content"');
  expect(serialized).not.toContain("private_key");
  expect(serialized).toContain("ciphertext");
  expect(new Set(tools.map((tool: Tool): string => tool.name)).size).toBe(tools.length);
});
