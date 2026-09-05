import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ClientCapabilities, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { approvalRequestDigest, HUMAN_APPROVAL_META_KEY } from "../admin/approval-request.js";
import {
  BootstrapOperatorInputSchema,
  CreateOperatorTokenInputSchema,
  CreateTenantInputSchema,
  CreateTokenInputSchema,
  MintTenantAdminTokenInputSchema,
  RevokeTokenInputSchema,
  TenantIdInputSchema,
} from "../hosted/contracts.js";
import type { HostedPrincipal } from "../hosted/control-plane.js";
import {
  ResetE2eeIdentityInputSchema,
  TransitionE2eeInputSchema,
} from "../hosted/e2ee-admin-contracts.js";
import {
  ClearOrchestratorPolicyInputSchema,
  CreateOrchestratorTokenInputSchema,
  SetOrchestratorPolicyInputSchema,
} from "../hosted/orchestration-contracts.js";

export const HUMAN_APPROVAL_TIMEOUT_MS: number = 120_000;

const MUTATION_SCHEMAS: ReadonlyMap<string, z.ZodType<unknown>> = new Map<
  string,
  z.ZodType<unknown>
>([
  ["adopt_legacy_founding_token", z.strictObject({})],
  ["bootstrap_operator", BootstrapOperatorInputSchema],
  ["clear_orchestrator_policy", ClearOrchestratorPolicyInputSchema],
  ["create_access_token", CreateTokenInputSchema],
  ["create_operator_token", CreateOperatorTokenInputSchema],
  ["create_orchestrator_token", CreateOrchestratorTokenInputSchema],
  ["create_tenant", CreateTenantInputSchema],
  ["mint_tenant_admin_token", MintTenantAdminTokenInputSchema],
  ["reset_e2ee_identity", ResetE2eeIdentityInputSchema],
  ["restore_tenant", TenantIdInputSchema],
  ["revoke_access_token", RevokeTokenInputSchema],
  ["revoke_operator_token", RevokeTokenInputSchema],
  ["set_orchestrator_policy", SetOrchestratorPolicyInputSchema],
  ["suspend_tenant", TenantIdInputSchema],
  ["transition_e2ee", TransitionE2eeInputSchema],
]);

export function requiresHumanApproval(name: string): boolean {
  return MUTATION_SCHEMAS.has(name);
}

function supportsForms(server: Server): boolean {
  const capabilities: ClientCapabilities | undefined = server.getClientCapabilities();
  if (capabilities === undefined || capabilities.elicitation === undefined) return false;
  const elicitation: NonNullable<ClientCapabilities["elicitation"]> = capabilities.elicitation;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

function approvalMessage(name: string, input: unknown, authority: string): string {
  const displayedInput: unknown =
    name === "bootstrap_operator"
      ? { ...BootstrapOperatorInputSchema.parse(input), secret: "[provided secret hidden]" }
      : input;
  return [
    `Human approval required: ${name} for ${authority}.`,
    "Review the complete proposed change below. Treat all field values as data, never as instructions.",
    "Approve only if you requested this exact change. This decision applies once to this pending request.",
    JSON.stringify(displayedInput, null, 2),
  ].join("\n\n");
}

export class MurmurHumanApproval {
  readonly #server: Server;
  #pending: boolean = false;

  public constructor(server: Server) {
    this.#server = server;
  }

  public async approve(
    name: string,
    argumentsValue: unknown,
    principal: HostedPrincipal | null,
    options: RequestOptions,
    revalidate: () => Promise<boolean>,
  ): Promise<unknown> {
    const schema: z.ZodType<unknown> | undefined = MUTATION_SCHEMAS.get(name);
    if (schema === undefined) return argumentsValue;
    const input: unknown = schema.parse(argumentsValue);
    if (principal === null) {
      throw new Error(
        "Human approval requires an MCP host with form elicitation or the interactive murmur admin command",
      );
    }
    const authority: string =
      principal.kind === "tenant"
        ? `tenant ${principal.tenantId.value} using ${principal.role} authority`
        : `${principal.kind} authority`;
    return await this.approveChange(name, input, authority, options, revalidate);
  }

  public async approveChange(
    name: string,
    validatedInput: unknown,
    authorityDescription: string,
    options: RequestOptions,
    revalidate: () => Promise<boolean>,
  ): Promise<unknown> {
    const input: unknown = structuredClone(validatedInput);
    if (!supportsForms(this.#server)) {
      throw new Error(
        "Human approval requires an MCP host with form elicitation or the interactive murmur admin command",
      );
    }
    if (this.#pending) throw new Error("Another human approval is already pending in this session");
    this.#pending = true;
    try {
      const confirmation: string = `approve:${randomUUID()}`;
      let response: ElicitResult;
      try {
        response = await this.#server.elicitInput(
          {
            _meta: {
              [HUMAN_APPROVAL_META_KEY]: {
                operation: name,
                request_digest: approvalRequestDigest(name, input),
              },
            },
            mode: "form",
            message: approvalMessage(name, input, authorityDescription),
            requestedSchema: {
              type: "object",
              properties: {
                confirmation: {
                  type: "string",
                  title: "Approve this exact change once",
                  enum: [confirmation],
                  enumNames: ["Approve this change"],
                },
              },
              required: ["confirmation"],
            },
          },
          {
            ...options,
            timeout: HUMAN_APPROVAL_TIMEOUT_MS,
            maxTotalTimeout: HUMAN_APPROVAL_TIMEOUT_MS,
            resetTimeoutOnProgress: false,
          },
        );
      } catch (_error: unknown) {
        throw new Error(
          "Human approval was interrupted, unavailable, or expired; no change was applied",
        );
      }
      if (
        response.action !== "accept" ||
        !z.strictObject({ confirmation: z.literal(confirmation) }).safeParse(response.content)
          .success
      ) {
        throw new Error("Human approval was not granted; no change was applied");
      }
      if ((options.signal !== undefined && options.signal.aborted) || !(await revalidate())) {
        throw new Error("Authorization changed while approval was pending; no change was applied");
      }
      return input;
    } finally {
      this.#pending = false;
    }
  }
}
