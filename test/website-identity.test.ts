import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  MAXIMUM_IDENTITY_BYTES,
  validateWebsiteIdentity,
} from "../scripts/verify-website-identity.js";

const ACCOUNT_ID: string = "a".repeat(32);
const SCRIPT: string = fileURLToPath(
  new URL("../scripts/verify-website-identity.ts", import.meta.url),
);

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function identity(loggedIn: boolean, accountId: string): Uint8Array {
  return bytes(JSON.stringify({ loggedIn, accounts: [{ id: accountId }] }));
}

describe("website deployment identity", (): void => {
  test("rejects empty output even when Wrangler exits successfully", (): void => {
    expect(validateWebsiteIdentity(bytes(""), ACCOUNT_ID)).toBe(false);
  });

  test("rejects malformed JSON and invalid UTF-8 without exposing input", (): void => {
    expect(validateWebsiteIdentity(bytes("not-json"), ACCOUNT_ID)).toBe(false);
    expect(validateWebsiteIdentity(new Uint8Array([255]), ACCOUNT_ID)).toBe(false);
  });

  test("rejects logged-out and wrong-account identities", (): void => {
    expect(validateWebsiteIdentity(identity(false, ACCOUNT_ID), ACCOUNT_ID)).toBe(false);
    expect(validateWebsiteIdentity(identity(true, "b".repeat(32)), ACCOUNT_ID)).toBe(false);
  });

  test("requires boolean authentication and a valid accounts array", (): void => {
    for (const value of [null, [], {}, { loggedIn: "true", accounts: [{ id: ACCOUNT_ID }] }]) {
      expect(validateWebsiteIdentity(bytes(JSON.stringify(value)), ACCOUNT_ID)).toBe(false);
    }
    expect(validateWebsiteIdentity(bytes('{"loggedIn":true,"accounts":[]}'), ACCOUNT_ID)).toBe(
      false,
    );
  });

  test("rejects invalid configured accounts and oversized responses", (): void => {
    expect(validateWebsiteIdentity(identity(true, ACCOUNT_ID), "invalid")).toBe(false);
    expect(validateWebsiteIdentity(new Uint8Array(MAXIMUM_IDENTITY_BYTES + 1), ACCOUNT_ID)).toBe(
      false,
    );
  });

  test("accepts a logged-in identity containing the exact configured account", (): void => {
    expect(validateWebsiteIdentity(identity(true, ACCOUNT_ID), ACCOUNT_ID)).toBe(true);
    const content: Uint8Array = bytes(
      JSON.stringify({
        loggedIn: true,
        authType: "Account API Token",
        accounts: [{ id: "b".repeat(32) }, { id: ACCOUNT_ID }],
      }),
    );
    expect(validateWebsiteIdentity(content, ACCOUNT_ID)).toBe(true);
  });

  test("the portable command rejects empty and missing artifacts with fixed safe output", (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-identity-"));
    const path: string = join(directory, "identity.json");
    try {
      for (const content of [identity(true, ACCOUNT_ID), bytes("")]) {
        writeFileSync(path, content);
        const result: Bun.ReadableSyncSubprocess = Bun.spawnSync([process.execPath, SCRIPT], {
          env: { WEBSITE_IDENTITY_FILE: path, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5_000,
        });
        expect(result.exitCode).toBe(content.byteLength === 0 ? 1 : 0);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toBe(
          content.byteLength === 0
            ? "Wrangler did not verify the configured Cloudflare account.\n"
            : "",
        );
      }
      const missing: Bun.ReadableSyncSubprocess = Bun.spawnSync([process.execPath, SCRIPT], {
        env: {
          WEBSITE_IDENTITY_FILE: join(directory, "missing.json"),
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        "Wrangler did not verify the configured Cloudflare account.\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
