import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MarkMessagesReadInputSchema, MarkMessagesReadOutputSchema } from "../domain/contracts.js";
import {
  CancelEncryptedBroadcastInputSchema,
  CancelEncryptedBroadcastOutputSchema,
  ClaimEncryptionPrekeyInputSchema,
  ClaimEncryptionPrekeyOutputSchema,
  CommitEncryptedBroadcastInputSchema,
  CommitEncryptedBroadcastOutputSchema,
  E2eeCapabilityInputSchema,
  E2eeCapabilityOutputSchema,
  EncryptedInboxOutputSchema,
  GetEncryptedMessagesInputSchema,
  GetInboxSummaryInputSchema,
  GetInboxSummaryOutputSchema,
  PrepareEncryptedBroadcastInputSchema,
  PrepareEncryptedBroadcastOutputSchema,
  PublishAgentKeyBundleInputSchema,
  PublishAgentKeyBundleOutputSchema,
  PutEncryptedBroadcastDeliveryInputSchema,
  PutEncryptedBroadcastDeliveryOutputSchema,
  PutEncryptedMessageInputSchema,
  PutEncryptedMessageOutputSchema,
  WaitForEncryptedMessagesInputSchema,
  WaitForEncryptedMessagesOutputSchema,
} from "./wire-tools.js";

function wireTool<Input, Output>(
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  annotations: ToolAnnotations,
): Tool {
  const generatedInput: unknown = z.toJSONSchema(inputSchema);
  const generatedOutput: unknown = z.toJSONSchema(outputSchema);
  return {
    annotations,
    description,
    inputSchema: ToolSchema.shape.inputSchema.parse(generatedInput),
    name,
    outputSchema: ToolSchema.shape.outputSchema.unwrap().parse(generatedOutput),
    title,
  };
}

const READ_ONLY: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  readOnlyHint: true,
};
const IDEMPOTENT_WRITE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  readOnlyHint: false,
};
const WRITE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  readOnlyHint: false,
};

export function encryptedWireToolDefinitions(): readonly Tool[] {
  return [
    wireTool(
      "get_e2ee_capability",
      "Read E2E capability",
      "Read the authenticated tenant's server-derived E2E enforcement state and wire limits.",
      E2eeCapabilityInputSchema,
      E2eeCapabilityOutputSchema,
      READ_ONLY,
    ),
    wireTool(
      "publish_agent_key_bundle",
      "Publish public encryption keys",
      "Publish one agent's bounded public signing and encryption bundle. Private keys are never accepted.",
      PublishAgentKeyBundleInputSchema,
      PublishAgentKeyBundleOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "claim_encryption_prekey",
      "Claim recipient encryption key",
      "Claim one recipient prekey and server-derived provenance for a direct encrypted delivery.",
      ClaimEncryptionPrekeyInputSchema,
      ClaimEncryptionPrekeyOutputSchema,
      WRITE,
    ),
    wireTool(
      "put_encrypted_message",
      "Store encrypted message",
      "Commit one signed ciphertext envelope against its bounded recipient prekey claim.",
      PutEncryptedMessageInputSchema,
      PutEncryptedMessageOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "get_encrypted_messages",
      "Read encrypted inbox",
      "Read ciphertext envelopes from one durable inbox without exposing plaintext to the service.",
      GetEncryptedMessagesInputSchema,
      EncryptedInboxOutputSchema,
      READ_ONLY,
    ),
    wireTool(
      "wait_for_encrypted_messages",
      "Wait for encrypted messages",
      "Wait up to 25 seconds for ciphertext envelopes without exposing plaintext to the service.",
      WaitForEncryptedMessagesInputSchema,
      WaitForEncryptedMessagesOutputSchema,
      READ_ONLY,
    ),
    wireTool(
      "mark_messages_read",
      "Mark encrypted messages read",
      "Mark encrypted message identifiers read for the authenticated tenant inbox.",
      MarkMessagesReadInputSchema,
      MarkMessagesReadOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "prepare_encrypted_broadcast",
      "Prepare encrypted broadcast",
      "Atomically snapshot a bounded audience and claim one public recipient prekey per member.",
      PrepareEncryptedBroadcastInputSchema,
      PrepareEncryptedBroadcastOutputSchema,
      WRITE,
    ),
    wireTool(
      "put_encrypted_broadcast_delivery",
      "Upload encrypted broadcast delivery",
      "Upload one invisible signed ciphertext delivery for a pending broadcast snapshot.",
      PutEncryptedBroadcastDeliveryInputSchema,
      PutEncryptedBroadcastDeliveryOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "commit_encrypted_broadcast",
      "Commit encrypted broadcast",
      "Atomically publish a complete encrypted broadcast after every snapshot delivery exists.",
      CommitEncryptedBroadcastInputSchema,
      CommitEncryptedBroadcastOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "cancel_encrypted_broadcast",
      "Cancel encrypted broadcast",
      "Cancel one pending encrypted broadcast and release its uncommitted prekey claims.",
      CancelEncryptedBroadcastInputSchema,
      CancelEncryptedBroadcastOutputSchema,
      IDEMPOTENT_WRITE,
    ),
    wireTool(
      "get_inbox_summary",
      "Read encrypted inbox summary",
      "Read only unread count and cursor metadata for a ciphertext inbox.",
      GetInboxSummaryInputSchema,
      GetInboxSummaryOutputSchema,
      READ_ONLY,
    ),
  ];
}
