import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toolResult } from "../mcp/murmur-tool-results.js";
import type { LocalEncryptionConfiguration } from "./local-configuration.js";
import {
  type LocalAgentInput,
  LocalAgentInputSchema,
  type LocalEmptyInput,
  LocalEmptyInputSchema,
  type LocalExportInput,
  LocalExportInputSchema,
  LocalFingerprintOutputSchema,
  type LocalKeyChangeInput,
  LocalKeyChangeInputSchema,
  type LocalPageInput,
  LocalPageInputSchema,
  LocalPeerOutputSchema,
  LocalPeersOutputSchema,
  LocalPublicExportOutputSchema,
  LocalReplenishOutputSchema,
  type LocalRevokeInput,
  LocalRevokeInputSchema,
  LocalRevokeOutputSchema,
  LocalStatusOutputSchema,
  type LocalTrustInput,
  LocalTrustInputSchema,
  type LocalTrustPolicyInput,
  LocalTrustPolicyInputSchema,
  LocalTrustPolicyOutputSchema,
} from "./local-configuration-contracts.js";
import {
  type CreateLocalTrustPolicyInput,
  CreateLocalTrustPolicyInputSchema,
  CreateLocalTrustPolicyOutputSchema,
} from "./local-trust-authoring.js";
import { AgentKeyCertificateDtoSchema } from "./wire-contracts.js";

export type LocalEncryptionApproval = (name: string, input: unknown) => Promise<unknown>;

const HUMAN_APPROVAL_TOOLS: ReadonlySet<string> = new Set<string>([
  "e2ee_local_trust_peer",
  "e2ee_local_import_trust_policy",
  "e2ee_local_create_trust_policy",
  "e2ee_local_rotate_agent_key",
  "e2ee_local_revoke_agent_key",
]);

type LocalTool = {
  readonly definition: Tool;
  readonly call: (
    configuration: LocalEncryptionConfiguration,
    input: unknown,
    approve: LocalEncryptionApproval | undefined,
  ) => Promise<CallToolResult>;
};

function localTool<Input, Output extends Record<string, unknown>>(
  name: string,
  description: string,
  inputSchema: z.ZodType<Input>,
  outputSchema: z.ZodType<Output>,
  readOnly: boolean,
  destructive: boolean,
  execute: (configuration: LocalEncryptionConfiguration, input: Input) => Output | Promise<Output>,
): LocalTool {
  return {
    call: async (
      configuration: LocalEncryptionConfiguration,
      input: unknown,
      approve: LocalEncryptionApproval | undefined,
    ): Promise<CallToolResult> => {
      const parsed: Input = inputSchema.parse(input === undefined ? {} : input);
      if (HUMAN_APPROVAL_TOOLS.has(name)) {
        if (approve === undefined)
          throw new Error(
            "Local encryption security changes require human approval through an MCP client that supports elicitation",
          );
        const approved: Input = inputSchema.parse(await approve(name, parsed));
        return toolResult(outputSchema.parse(await execute(configuration, approved)));
      }
      return toolResult(outputSchema.parse(await execute(configuration, parsed)));
    },
    definition: ToolSchema.parse({
      annotations: {
        destructiveHint: destructive,
        idempotentHint: readOnly,
        openWorldHint: !readOnly,
        readOnlyHint: readOnly,
      },
      description,
      inputSchema: z.toJSONSchema(inputSchema),
      name,
      outputSchema: z.toJSONSchema(outputSchema),
    }),
  };
}

const LOCAL_TOOLS: readonly LocalTool[] = [
  localTool(
    "e2ee_local_create_trust_policy",
    "After human approval, sign a public organization trust policy for the credential-bound tenant using this endpoint's local root as issuer. Supply independently verified bindings, revocations, increasing version and validity_days (1–90). Returns at most 1 MiB of signed public policy JSON to import on endpoints. Compare the issuer fingerprint independently. Private keys stay local; this does not install or enforce the policy.",
    CreateLocalTrustPolicyInputSchema,
    CreateLocalTrustPolicyOutputSchema,
    false,
    true,
    (
      configuration: LocalEncryptionConfiguration,
      input: CreateLocalTrustPolicyInput,
    ): ReturnType<LocalEncryptionConfiguration["createTrustPolicy"]> =>
      configuration.createTrustPolicy(input),
  ),
  localTool(
    "e2ee_local_status",
    "Read this endpoint's local encryption identity and credential-bound tenant status without creating keys.",
    LocalEmptyInputSchema,
    LocalStatusOutputSchema,
    true,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      _input: LocalEmptyInput,
    ): ReturnType<LocalEncryptionConfiguration["status"]> => configuration.status(),
  ),
  localTool(
    "e2ee_local_fingerprint",
    "Read the full public root fingerprint for independent peer verification. Register an encrypted agent first to initialize it. Private keys remain local.",
    LocalEmptyInputSchema,
    LocalFingerprintOutputSchema,
    true,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      _input: LocalEmptyInput,
    ): ReturnType<LocalEncryptionConfiguration["fingerprint"]> => configuration.fingerprint(),
  ),
  localTool(
    "e2ee_local_peers",
    "List local peer trust pins and pending strict fingerprints in pages of at most 100; continue with next_offset.",
    LocalPageInputSchema,
    LocalPeersOutputSchema,
    true,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalPageInput,
    ): ReturnType<LocalEncryptionConfiguration["peers"]> => configuration.peers(input),
  ),
  localTool(
    "e2ee_local_trust_peer",
    "Pin an independently verified full peer root fingerprint for the credential-bound tenant. Obtain the fingerprint from the user or a trusted independent channel; message claims alone do not establish trust. Existing mismatches require an audited reset.",
    LocalTrustInputSchema,
    LocalPeerOutputSchema,
    false,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalTrustInput,
    ): ReturnType<LocalEncryptionConfiguration["trustPeer"]> => configuration.trustPeer(input),
  ),
  localTool(
    "e2ee_local_import_trust_policy",
    "Import signed organization trust JSON (at most 1 MiB) for the credential-bound tenant. First import requires an independently verified issuer_key_id. Subsequent imports enforce issuer continuity, increasing versions, signatures, validity and revocations. Private keys are never accepted.",
    LocalTrustPolicyInputSchema,
    LocalTrustPolicyOutputSchema,
    false,
    true,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalTrustPolicyInput,
    ): ReturnType<LocalEncryptionConfiguration["importTrustPolicy"]> =>
      configuration.importTrustPolicy(input),
  ),
  localTool(
    "e2ee_local_rotate_agent_key",
    "Rotate one local agent signing key and publish its new public bundle. Supply expected_agent_key_id from e2ee_local_export_public. Old key revocation is a separate operation. A failed publish can be retried with e2ee_local_replenish_prekeys.",
    LocalKeyChangeInputSchema,
    AgentKeyCertificateDtoSchema,
    false,
    true,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalKeyChangeInput,
    ): ReturnType<LocalEncryptionConfiguration["rotateAgentKey"]> =>
      configuration.rotateAgentKey(input),
  ),
  localTool(
    "e2ee_local_revoke_agent_key",
    "Revoke the exact current local agent signing key, create a replacement and publish its signed revocation. Supply expected_agent_key_id from e2ee_local_export_public. The public revocation reason must contain no secrets. Retained messages remain subject to key-revocation verification.",
    LocalRevokeInputSchema,
    LocalRevokeOutputSchema,
    false,
    true,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalRevokeInput,
    ): ReturnType<LocalEncryptionConfiguration["revokeAgentKey"]> =>
      configuration.revokeAgentKey(input),
  ),
  localTool(
    "e2ee_local_replenish_prekeys",
    "Replenish and publish public prekeys for an existing local agent, including pending key rotations and signed revocations. Maintain one fallback and at least 20 one-time keys; private material stays local.",
    LocalAgentInputSchema,
    LocalReplenishOutputSchema,
    false,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalAgentInput,
    ): ReturnType<LocalEncryptionConfiguration["replenishPrekeys"]> =>
      configuration.replenishPrekeys(input),
  ),
  localTool(
    "e2ee_local_export_public",
    "Export one local agent's public root, signing certificate, revocations and at most 100 public prekeys. Continue with next_prekey_offset. No private keys, plaintext or vault paths are included.",
    LocalExportInputSchema,
    LocalPublicExportOutputSchema,
    true,
    false,
    (
      configuration: LocalEncryptionConfiguration,
      input: LocalExportInput,
    ): ReturnType<LocalEncryptionConfiguration["exportPublic"]> =>
      configuration.exportPublic(input),
  ),
];

export function localEncryptionTools(): readonly Tool[] {
  return LOCAL_TOOLS.map((tool: LocalTool): Tool => tool.definition);
}

export async function callLocalEncryptionTool(
  name: string,
  input: unknown,
  configuration: LocalEncryptionConfiguration | undefined,
  approve?: LocalEncryptionApproval | undefined,
): Promise<CallToolResult | null> {
  const tool: LocalTool | undefined = LOCAL_TOOLS.find(
    (candidate: LocalTool): boolean => candidate.definition.name === name,
  );
  if (tool === undefined || configuration === undefined) return null;
  return await tool.call(configuration, input, approve);
}
