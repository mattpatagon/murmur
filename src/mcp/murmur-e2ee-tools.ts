import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type MarkMessagesReadInput,
  MarkMessagesReadInputSchema,
  type MarkMessagesReadOutput,
  MarkMessagesReadOutputSchema,
} from "../domain/contracts.js";
import {
  E2EE_CAPABILITY_TOOL_NAME,
  E2EE_ENFORCED_TOOL_NAMES,
  E2EE_KEY_PROVISIONING_TOOL_NAMES,
  type E2eeEntitlementRecord,
} from "../hosted/e2ee-entitlement.js";
import type { E2eeMessageStore } from "../storage/e2ee-message-store.js";
import type { InboxSubscription } from "../storage/message-store.js";
import {
  type CancelEncryptedBroadcastInput,
  CancelEncryptedBroadcastInputSchema,
  type CancelEncryptedBroadcastOutput,
  CancelEncryptedBroadcastOutputSchema,
  type ClaimEncryptionPrekeyInput,
  ClaimEncryptionPrekeyInputSchema,
  type ClaimEncryptionPrekeyOutput,
  ClaimEncryptionPrekeyOutputSchema,
  type CommitEncryptedBroadcastInput,
  CommitEncryptedBroadcastInputSchema,
  type CommitEncryptedBroadcastOutput,
  CommitEncryptedBroadcastOutputSchema,
  type E2eeCapabilityOutput,
  E2eeCapabilityInputSchema,
  E2eeCapabilityOutputSchema,
  type EncryptedInboxOutput,
  EncryptedInboxOutputSchema,
  type EncryptedMessageDto,
  type GetEncryptedMessagesInput,
  GetEncryptedMessagesInputSchema,
  type GetInboxSummaryInput,
  GetInboxSummaryInputSchema,
  type GetInboxSummaryOutput,
  GetInboxSummaryOutputSchema,
  type PrepareEncryptedBroadcastInput,
  PrepareEncryptedBroadcastInputSchema,
  type PrepareEncryptedBroadcastOutput,
  PrepareEncryptedBroadcastOutputSchema,
  type PublishAgentKeyBundleInput,
  PublishAgentKeyBundleInputSchema,
  type PublishAgentKeyBundleOutput,
  PublishAgentKeyBundleOutputSchema,
  type PutEncryptedBroadcastDeliveryInput,
  PutEncryptedBroadcastDeliveryInputSchema,
  type PutEncryptedBroadcastDeliveryOutput,
  PutEncryptedBroadcastDeliveryOutputSchema,
  type PutEncryptedMessageInput,
  PutEncryptedMessageInputSchema,
  type PutEncryptedMessageOutput,
  PutEncryptedMessageOutputSchema,
  type WaitForEncryptedMessagesInput,
  WaitForEncryptedMessagesInputSchema,
  type WaitForEncryptedMessagesOutput,
  WaitForEncryptedMessagesOutputSchema,
} from "../e2ee/wire-tools.js";
import { toolResult } from "./murmur-tool-results.js";

export type E2eeToolContext = {
  readonly capability: E2eeCapabilityOutput;
  readonly entitlement: E2eeEntitlementRecord;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly store: E2eeMessageStore | null;
};

function isRoutedTool(name: string, entitlement: E2eeEntitlementRecord): boolean {
  if (name === E2EE_CAPABILITY_TOOL_NAME) return true;
  if (entitlement.state === "provisioning") {
    return E2EE_KEY_PROVISIONING_TOOL_NAMES.includes(name);
  }
  return entitlement.state === "enforced" && E2EE_ENFORCED_TOOL_NAMES.includes(name);
}

function dataStore(context: E2eeToolContext): E2eeMessageStore {
  if (context.store === null) throw new Error("This credential cannot access tenant E2E data");
  return context.store;
}

function result(output: Record<string, unknown>): CallToolResult {
  return toolResult(output);
}

function validateCapability(context: E2eeToolContext): E2eeCapabilityOutput {
  const capability: E2eeCapabilityOutput = E2eeCapabilityOutputSchema.parse(context.capability);
  if (capability.state !== context.entitlement.state) {
    throw new Error("Hosted E2E capability state is inconsistent");
  }
  return capability;
}

function checkedInbox(
  input: GetEncryptedMessagesInput,
  output: EncryptedInboxOutput,
): EncryptedInboxOutput {
  if (output.agent_id !== input.agent_id) {
    throw new Error("Encrypted inbox identity is inconsistent");
  }
  const newest: EncryptedMessageDto | undefined = output.messages.at(-1);
  if (newest !== undefined && output.inbox_version < newest.tenant_sequence) {
    throw new Error("Encrypted inbox version is inconsistent");
  }
  return output;
}

async function waitForEncryptedMessages(
  input: WaitForEncryptedMessagesInput,
  context: E2eeToolContext,
): Promise<WaitForEncryptedMessagesOutput> {
  const store: E2eeMessageStore = dataStore(context);
  const query: GetEncryptedMessagesInput = {
    after_sequence: input.after_sequence,
    agent_id: input.agent_id,
    limit: 100,
    unread_only: false,
  };
  let inbox: EncryptedInboxOutput = checkedInbox(
    query,
    EncryptedInboxOutputSchema.parse(await store.getEncryptedMessages(query)),
  );
  let timedOut: boolean = false;
  if (inbox.messages.length === 0) {
    let resolveUpdate: (() => void) | null = null;
    const updatePromise: Promise<void> = new Promise((resolve: () => void): void => {
      resolveUpdate = resolve;
    });
    const subscription: InboxSubscription = await store.watchEncryptedInbox(
      input.agent_id,
      input.after_sequence,
      async (): Promise<void> => {
        const resolver: (() => void) | null = resolveUpdate;
        if (resolver !== null) resolver();
      },
    );
    try {
      const updateOutcome: Promise<"updated"> = updatePromise.then((): "updated" => "updated");
      const timeoutOutcome: Promise<"timed_out"> = context
        .sleep(input.timeout_seconds * 1_000)
        .then((): "timed_out" => "timed_out");
      timedOut = (await Promise.race([updateOutcome, timeoutOutcome])) === "timed_out";
      inbox = checkedInbox(
        query,
        EncryptedInboxOutputSchema.parse(await store.getEncryptedMessages(query)),
      );
    } finally {
      await subscription.close();
    }
  }
  return WaitForEncryptedMessagesOutputSchema.parse({
    agent_id: input.agent_id,
    messages: inbox.messages,
    timed_out: timedOut && inbox.messages.length === 0,
  });
}

export async function callE2eeTool(
  name: string,
  argumentsValue: unknown,
  context: E2eeToolContext,
): Promise<CallToolResult | null> {
  if (!isRoutedTool(name, context.entitlement)) return null;
  switch (name) {
    case "get_e2ee_capability": {
      E2eeCapabilityInputSchema.parse(argumentsValue);
      return result(validateCapability(context));
    }
    case "publish_agent_key_bundle": {
      const input: PublishAgentKeyBundleInput =
        PublishAgentKeyBundleInputSchema.parse(argumentsValue);
      const output: PublishAgentKeyBundleOutput = PublishAgentKeyBundleOutputSchema.parse(
        await dataStore(context).publishAgentKeyBundle(input),
      );
      if (output.agent_id !== input.agent_id) {
        throw new Error("Published E2E identity acknowledgement is inconsistent");
      }
      return result(output);
    }
    case "claim_encryption_prekey": {
      const input: ClaimEncryptionPrekeyInput =
        ClaimEncryptionPrekeyInputSchema.parse(argumentsValue);
      const output: ClaimEncryptionPrekeyOutput = ClaimEncryptionPrekeyOutputSchema.parse(
        await dataStore(context).claimEncryptionPrekey(input),
      );
      if (output.recipient_id !== input.recipient_id) {
        throw new Error("Encryption claim recipient is inconsistent");
      }
      return result(output);
    }
    case "put_encrypted_message": {
      const input: PutEncryptedMessageInput = PutEncryptedMessageInputSchema.parse(argumentsValue);
      const output: PutEncryptedMessageOutput = PutEncryptedMessageOutputSchema.parse(
        await dataStore(context).putEncryptedMessage(input),
      );
      return result(output);
    }
    case "get_encrypted_messages": {
      const input: GetEncryptedMessagesInput =
        GetEncryptedMessagesInputSchema.parse(argumentsValue);
      const output: EncryptedInboxOutput = checkedInbox(
        input,
        EncryptedInboxOutputSchema.parse(await dataStore(context).getEncryptedMessages(input)),
      );
      return result(output);
    }
    case "wait_for_encrypted_messages": {
      const input: WaitForEncryptedMessagesInput =
        WaitForEncryptedMessagesInputSchema.parse(argumentsValue);
      return result(await waitForEncryptedMessages(input, context));
    }
    case "mark_messages_read": {
      const input: MarkMessagesReadInput = MarkMessagesReadInputSchema.parse(argumentsValue);
      const output: MarkMessagesReadOutput = MarkMessagesReadOutputSchema.parse(
        await dataStore(context).markEncryptedMessagesRead(input),
      );
      return result(output);
    }
    case "prepare_encrypted_broadcast": {
      const input: PrepareEncryptedBroadcastInput =
        PrepareEncryptedBroadcastInputSchema.parse(argumentsValue);
      const output: PrepareEncryptedBroadcastOutput = PrepareEncryptedBroadcastOutputSchema.parse(
        await dataStore(context).prepareEncryptedBroadcast(input),
      );
      return result(output);
    }
    case "put_encrypted_broadcast_delivery": {
      const input: PutEncryptedBroadcastDeliveryInput =
        PutEncryptedBroadcastDeliveryInputSchema.parse(argumentsValue);
      const output: PutEncryptedBroadcastDeliveryOutput =
        PutEncryptedBroadcastDeliveryOutputSchema.parse(
          await dataStore(context).putEncryptedBroadcastDelivery(input),
        );
      return result(output);
    }
    case "commit_encrypted_broadcast": {
      const input: CommitEncryptedBroadcastInput =
        CommitEncryptedBroadcastInputSchema.parse(argumentsValue);
      const output: CommitEncryptedBroadcastOutput = CommitEncryptedBroadcastOutputSchema.parse(
        await dataStore(context).commitEncryptedBroadcast(input),
      );
      if (output.broadcast_id !== input.broadcast_id) {
        throw new Error("Encrypted broadcast commit acknowledgement is inconsistent");
      }
      return result(output);
    }
    case "cancel_encrypted_broadcast": {
      const input: CancelEncryptedBroadcastInput =
        CancelEncryptedBroadcastInputSchema.parse(argumentsValue);
      const output: CancelEncryptedBroadcastOutput = CancelEncryptedBroadcastOutputSchema.parse(
        await dataStore(context).cancelEncryptedBroadcast(input),
      );
      return result(output);
    }
    case "get_inbox_summary": {
      const input: GetInboxSummaryInput = GetInboxSummaryInputSchema.parse(argumentsValue);
      const output: GetInboxSummaryOutput = GetInboxSummaryOutputSchema.parse(
        await dataStore(context).getEncryptedInboxSummary(input),
      );
      if (output.agent_id !== input.agent_id) {
        throw new Error("Encrypted inbox summary identity is inconsistent");
      }
      return result(output);
    }
    default:
      return null;
  }
}
