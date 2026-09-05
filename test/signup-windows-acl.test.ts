import { expect, test } from "bun:test";
import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  runSignupWindowsAcl,
  SIGNUP_ACL_TIMEOUT_MS,
  type SignupAclExecutor,
} from "../src/setup/signup-windows-acl.js";

function result(stdout: string, status: number = 0): SpawnSyncReturns<string> {
  return {
    output: [null, stdout, "sensitive subprocess fixture"],
    pid: 1,
    signal: null,
    status,
    stderr: "sensitive subprocess fixture",
    stdout,
  };
}

test("Windows signup ACL subprocess has a deadline, bounded output and data-only path arguments", (): void => {
  const maliciousPath: string = "C:\\credentials'; Write-Output unexpected; #";
  const execute: SignupAclExecutor = (
    command: string,
    arguments_: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string> => {
    expect(command).toBe("powershell.exe");
    expect(arguments_).toHaveLength(5);
    expect(arguments_).not.toContain(maliciousPath);
    expect(arguments_[3]).toBe("-EncodedCommand");
    expect(options.timeout).toBe(SIGNUP_ACL_TIMEOUT_MS);
    expect(options.timeout).toBeLessThanOrEqual(5000);
    expect(options.maxBuffer).toBe(4096);
    expect(options.env).toMatchObject({
      MURMUR_SIGNUP_ACL_PATH: maliciousPath,
      MURMUR_SIGNUP_ACL_DIRECTORY: "1",
      MURMUR_SIGNUP_ACL_OPERATION: "protect",
    });
    return result('{"owner_only":true}');
  };
  runSignupWindowsAcl({ directory: true, operation: "protect", path: maliciousPath }, execute);
});

test("Windows signup ACL verification rejects process failures and unverified output without revealing stderr", (): void => {
  for (const output of [
    result('{"owner_only":true}', 1),
    result("invalid json"),
    result('{"owner_only":false}'),
    result('{"owner_only":true,"unvalidated":"data"}'),
    { ...result(""), error: new Error("sensitive subprocess fixture") },
  ]) {
    const execute: SignupAclExecutor = (
      _command: string,
      _arguments: readonly string[],
      _options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => output;
    expect((): void =>
      runSignupWindowsAcl(
        { directory: false, operation: "verify", path: "C:\\credentials\\owner.json" },
        execute,
      ),
    ).toThrow(/Windows/u);
    try {
      runSignupWindowsAcl(
        { directory: false, operation: "verify", path: "C:\\credentials\\owner.json" },
        execute,
      );
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw new Error("Expected a fixed ACL error");
      expect(error.message).not.toContain("sensitive subprocess fixture");
    }
  }
});

test("Windows signup exposes only allowlisted failed ACL stages for native diagnosis", (): void => {
  for (const stage of [
    "inspect_path",
    "create_descriptor",
    "create_rule",
    "apply_acl",
    "read_acl",
    "verify_rule_count",
    "verify_rights",
  ]) {
    const execute: SignupAclExecutor = (
      _command: string,
      _arguments: readonly string[],
      _options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => result(JSON.stringify({ owner_only: false, stage }), 1);
    expect((): void =>
      runSignupWindowsAcl(
        { directory: true, operation: "protect", path: "C:\\private\\credentials" },
        execute,
      ),
    ).toThrow(`stage: ${stage}`);
  }
  for (const stdout of [
    "invalid JSON",
    JSON.stringify({ owner_only: false, stage: "private path or secret" }),
    JSON.stringify({ owner_only: false, stage: "apply_acl", detail: "private path or secret" }),
  ]) {
    const execute: SignupAclExecutor = (
      _command: string,
      _arguments: readonly string[],
      _options: SpawnSyncOptionsWithStringEncoding,
    ): SpawnSyncReturns<string> => result(stdout, 1);
    expect((): void =>
      runSignupWindowsAcl(
        { directory: true, operation: "protect", path: "C:\\private\\credentials" },
        execute,
      ),
    ).toThrow(/^Windows could not establish owner-only signup credential permissions$/u);
  }
});

test.skipIf(process.platform !== "win32")(
  "native Windows signup removes preexisting explicit Everyone grants from directories and files",
  (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-acl-"));
    const file: string = join(directory, "owner.json");
    try {
      writeFileSync(file, "public test fixture");
      for (const path of [directory, file]) {
        const isDirectory: boolean = path === directory;
        runSignupWindowsAcl({ directory: isDirectory, operation: "protect", path });
        const grant: SpawnSyncReturns<string> = spawnSync(
          "icacls.exe",
          [path, "/grant", isDirectory ? "*S-1-1-0:(OI)(CI)(F)" : "*S-1-1-0:(F)"],
          { encoding: "utf8", maxBuffer: 4096, timeout: 5000, windowsHide: true },
        );
        expect(grant.status).toBe(0);
        expect((): void =>
          runSignupWindowsAcl({ directory: isDirectory, operation: "verify", path }),
        ).toThrow("owner-only");
        runSignupWindowsAcl({ directory: isDirectory, operation: "protect", path });
        runSignupWindowsAcl({ directory: isDirectory, operation: "verify", path });
      }
      expect(readFileSync(file, "utf8")).toBe("public test fixture");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  },
);
