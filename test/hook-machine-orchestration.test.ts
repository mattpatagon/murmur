import { describe, expect, test } from "bun:test";

import {
  type HookOrchestrationState,
  hookOrchestrationGuidance,
  hookOrchestrationState,
} from "../src/hook-orchestration.js";

const POLICY_ID: string = "10000000-0000-4000-8000-000000000001";
const PERSONAL_ID: string = "20000000-0000-4000-8000-000000000001";

function configuredScope(
  machine: string | null,
  repository: string | null,
  personalId: string | null = null,
): string {
  const state: HookOrchestrationState = hookOrchestrationState({
    caller_authority: "peer",
    orchestrator: {
      agent_id: "boss-agent",
      policy_id: POLICY_ID,
      scope: {
        machine,
        personal_id: personalId,
        repository,
        scope_kind: personalId === null ? "organization" : "personal",
      },
    },
  });
  if (state.kind !== "configured") throw new Error("Expected configured orchestration state");
  return state.scope;
}

describe("machine-qualified hook orchestration guidance", (): void => {
  test("describes every machine and repository qualifier combination", (): void => {
    expect(configuredScope(null, null)).toBe("organization; all machines; all repositories");
    expect(configuredScope("coder-vm", null)).toBe(
      "organization; machine coder-vm; all repositories",
    );
    expect(configuredScope(null, "mattpatagon/murmur")).toBe(
      "organization; all machines; repository mattpatagon/murmur",
    );
    expect(configuredScope("coder-vm", "mattpatagon/murmur")).toBe(
      "organization; machine coder-vm; repository mattpatagon/murmur",
    );
  });

  test("identifies personal scope together with machine and repository", (): void => {
    const state: HookOrchestrationState = {
      agentId: "boss-agent",
      kind: "configured",
      scope: configuredScope("laptop", "mattpatagon/murmur", PERSONAL_ID),
    };
    expect(state.scope).toBe(
      `personal ${PERSONAL_ID}; machine laptop; repository mattpatagon/murmur`,
    );
    expect(hookOrchestrationGuidance(state)).toContain(state.scope);
  });
});
