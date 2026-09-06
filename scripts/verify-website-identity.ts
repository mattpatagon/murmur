import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

export const MAXIMUM_IDENTITY_BYTES: number = 65_536;
const AccountIdSchema: z.ZodType<string> = z.string().regex(/^[a-fA-F0-9]{32}$/u);
type Account = { readonly id: string };
type Identity = { readonly loggedIn: true; readonly accounts: readonly Account[] };
const IdentitySchema: z.ZodType<Identity> = z.object({
  loggedIn: z.literal(true),
  accounts: z
    .array(z.object({ id: AccountIdSchema }))
    .min(1)
    .max(1_000),
});

export function validateWebsiteIdentity(content: Uint8Array, accountId: string): boolean {
  if (content.byteLength === 0 || content.byteLength > MAXIMUM_IDENTITY_BYTES) return false;
  if (!AccountIdSchema.safeParse(accountId).success) return false;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return false;
  }
  const result: z.ZodSafeParseResult<Identity> = IdentitySchema.safeParse(value);
  return (
    result.success &&
    result.data.accounts.some((account: Account): boolean => account.id === accountId)
  );
}

function readIdentity(path: string): Uint8Array {
  const descriptor: number = openSync(path, "r");
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Invalid identity artifact");
    const content: Uint8Array = new Uint8Array(MAXIMUM_IDENTITY_BYTES + 1);
    let offset: number = 0;
    while (offset < content.byteLength) {
      const count: number = readSync(
        descriptor,
        content,
        offset,
        content.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    return content.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function main(): void {
  try {
    const path: string | undefined = process.env["WEBSITE_IDENTITY_FILE"];
    const accountId: string | undefined = process.env["CLOUDFLARE_ACCOUNT_ID"];
    if (path === undefined || accountId === undefined) throw new Error("Missing identity input");
    if (!validateWebsiteIdentity(readIdentity(path), accountId)) {
      throw new Error("Unverified identity");
    }
  } catch {
    process.stderr.write("Wrangler did not verify the configured Cloudflare account.\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
