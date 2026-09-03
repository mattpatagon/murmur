import { isDeepStrictEqual } from "node:util";

import type {
  AgentKeyRevocationDto,
  PublicAgentKeyBundleDto,
} from "../../src/e2ee/wire-contracts.js";

function revocations(bundle: PublicAgentKeyBundleDto): readonly AgentKeyRevocationDto[] {
  return bundle.agent_key_revocations === undefined ? [] : bundle.agent_key_revocations;
}

export function requireMemoryMonotonicBundle(
  previous: PublicAgentKeyBundleDto,
  next: PublicAgentKeyBundleDto,
): void {
  if (previous.root_key_id !== next.root_key_id) {
    throw new Error("Published E2E root key cannot change");
  }
  const current: readonly AgentKeyRevocationDto[] = revocations(next);
  for (const prior of revocations(previous)) {
    const retained: AgentKeyRevocationDto | undefined = current.find(
      (candidate: AgentKeyRevocationDto): boolean =>
        candidate.revoked_signing_key_id === prior.revoked_signing_key_id,
    );
    if (retained === undefined || !isDeepStrictEqual(retained, prior)) {
      throw new Error("Published E2E agent revocations cannot be removed or changed");
    }
  }
}
