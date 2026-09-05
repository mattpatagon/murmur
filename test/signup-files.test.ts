import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  prepareSignupDirectory,
  readSignupPrivateFile,
  type SignupFileRuntime,
  saveSignupPrivateFile,
} from "../src/setup/signup-files.js";
import type { SignupAclRequest } from "../src/setup/signup-windows-acl.js";

function temporary(run: (directory: string) => void): void {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-signup-files-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("signup checks exact Windows ACLs before writing or reading credential material", (): void => {
  temporary((parent: string): void => {
    const directory: string = join(parent, "credentials");
    const file: string = join(directory, "registration.json");
    const calls: SignupAclRequest[] = [];
    const runtime: SignupFileRuntime = {
      platform: "win32",
      windowsAcl: (request: SignupAclRequest): void => {
        calls.push(request);
        if (!request.directory && calls.length === 3)
          expect(readFileSync(request.path, "utf8")).toBe("");
      },
    };
    prepareSignupDirectory(directory, runtime);
    saveSignupPrivateFile(file, { recovery: "local fixture" }, runtime);
    expect(readSignupPrivateFile(file, runtime)).toBe('{"recovery":"local fixture"}\n');
    expect(calls).toEqual([
      { directory: true, operation: "protect", path: directory },
      { directory: true, operation: "verify", path: directory },
      { directory: false, operation: "protect", path: file },
      { directory: true, operation: "verify", path: directory },
      { directory: false, operation: "protect", path: file },
    ]);
    expect((): void => saveSignupPrivateFile(file, { replaced: true }, runtime)).toThrow(
      "already exists",
    );
    expect(readFileSync(file, "utf8")).toContain("local fixture");
  });
});

test("failed Windows ACL application leaves no credential bytes or unusable empty checkpoint", (): void => {
  temporary((directory: string): void => {
    const file: string = join(directory, "owner.json");
    const runtime: SignupFileRuntime = {
      platform: "win32",
      windowsAcl: (request: SignupAclRequest): void => {
        if (!request.directory) {
          expect(readFileSync(request.path, "utf8")).toBe("");
          throw new Error("ACL refused");
        }
      },
    };
    expect((): void =>
      saveSignupPrivateFile(file, { fixture: "must stay unwritten" }, runtime),
    ).toThrow("ACL refused");
    expect(existsSync(file)).toBe(false);
    const deniedDirectory: SignupFileRuntime = {
      platform: "win32",
      windowsAcl: (_request: SignupAclRequest): void => {
        throw new Error("Directory ACL refused");
      },
    };
    expect((): void => saveSignupPrivateFile(file, {}, deniedDirectory)).toThrow(
      "Directory ACL refused",
    );
    expect(existsSync(file)).toBe(false);
  });
});

test("signup refuses unrelated contents and links before changing a directory ACL", (): void => {
  temporary((directory: string): void => {
    let calls: number = 0;
    const runtime: SignupFileRuntime = {
      platform: "win32",
      windowsAcl: (_request: SignupAclRequest): void => {
        calls += 1;
      },
    };
    const unrelated: string = join(directory, "notes.txt");
    writeFileSync(unrelated, "unrelated document");
    expect((): void => prepareSignupDirectory(directory, runtime)).toThrow("dedicated directory");
    expect(calls).toBe(0);
    rmSync(unrelated);
    const subdirectory: string = join(directory, "worker.json");
    mkdirSync(subdirectory);
    expect((): void => prepareSignupDirectory(directory, runtime)).toThrow("bounded regular");
    expect(calls).toBe(0);
    rmSync(subdirectory, { recursive: true });
    const credential: string = join(directory, "owner.json");
    writeFileSync(credential, "{}", { mode: 0o600 });
    linkSync(credential, join(directory, "registration.json"));
    expect((): void => prepareSignupDirectory(directory, runtime)).toThrow("without links");
    expect(calls).toBe(0);
  });
});

test.skipIf(process.platform === "win32")(
  "signup rejects symbolic links and permissive POSIX checkpoints",
  (): void => {
    temporary((parent: string): void => {
      const directory: string = join(parent, "credentials");
      prepareSignupDirectory(directory);
      const link: string = join(parent, "linked");
      symlinkSync(directory, link, "dir");
      expect((): void => prepareSignupDirectory(link)).toThrow("symbolic link");
      const file: string = join(directory, "worker.json");
      symlinkSync(join(parent, "outside"), file);
      expect((): void => prepareSignupDirectory(directory)).toThrow("without links");
      expect((): void => saveSignupPrivateFile(file, {})).toThrow();
      rmSync(file);
      writeFileSync(file, "{}", { mode: 0o600 });
      chmodSync(file, 0o644);
      expect((): string => readSignupPrivateFile(file)).toThrow("only to their owner");
      chmodSync(file, 0o600);
      expect(readSignupPrivateFile(file)).toBe("{}");
      expect(lstatSync(directory).mode & 0o077).toBe(0);
      chmodSync(directory, 0o755);
      expect((): void => prepareSignupDirectory(directory)).toThrow("directory must be private");
    });
  },
);

test("signup bounds serialized files and refuses noncredential destinations", (): void => {
  temporary((directory: string): void => {
    const runtime: SignupFileRuntime = {
      platform: "win32",
      windowsAcl: (_request: SignupAclRequest): void => undefined,
    };
    expect((): void => prepareSignupDirectory("relative", runtime)).toThrow("absolute");
    expect((): void => saveSignupPrivateFile(join(directory, "other.json"), {}, runtime)).toThrow(
      "recognized file",
    );
    const file: string = join(directory, "worker.json");
    expect((): void => saveSignupPrivateFile(file, "A".repeat(16384), runtime)).toThrow(
      "too large",
    );
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "A".repeat(16385), { mode: 0o600 });
    expect((): string => readSignupPrivateFile(file, runtime)).toThrow("bounded regular");
    writeFileSync(file, "A".repeat(16384), { mode: 0o600 });
    expect(readSignupPrivateFile(file, runtime)).toHaveLength(16384);
  });
});
