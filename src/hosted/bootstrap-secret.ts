import { createHmac } from "node:crypto";

import { hashTokenSecret } from "./token-secret.js";

const BOOTSTRAP_DERIVATION_CONTEXT: string = "murmur/operator-bootstrap/v1";

export type BootstrapCredential = {
  readonly hash: Buffer;
  readonly keyId: string;
  readonly secret: string;
};

export function deriveBootstrapCredential(databaseCredential: string): BootstrapCredential {
  if (databaseCredential === "") throw new Error("Bootstrap derivation credential is empty");
  const material: Buffer = createHmac("sha256", databaseCredential)
    .update(BOOTSTRAP_DERIVATION_CONTEXT, "utf8")
    .digest();
  const keyId: string = material.subarray(0, 6).toString("base64url");
  const secret: string = `mur_boot_${keyId}_${material.toString("base64url")}`;
  return {
    hash: hashTokenSecret(secret),
    keyId,
    secret,
  };
}
