import { z } from "zod";

import type { ExpectedPeerRoot, PeerPin } from "./local-vault-rows.js";

const ExpectedPeerRootSchema: z.ZodType<ExpectedPeerRoot> = z.strictObject({
  agentId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  rootKeyId: z.string().regex(/^mrk_[A-Za-z0-9_-]{43}$/u),
  tenantId: z.string().uuid(),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export function parseExpectedPeerRoot(input: ExpectedPeerRoot): ExpectedPeerRoot {
  return ExpectedPeerRootSchema.parse(input);
}

export function peerPinRank(mode: PeerPin["verificationMode"]): number {
  if (mode === "tofu") return 0;
  if (mode === "strict") return 1;
  return 2;
}
