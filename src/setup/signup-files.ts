import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import process from "node:process";

import { runSignupWindowsAcl, type SignupAclRequest } from "./signup-windows-acl.js";

const MAX_CREDENTIAL_BYTES: number = 16_384;
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set<string>([
  "registration.json",
  "owner.json",
  "worker.json",
]);

export type SignupFileRuntime = {
  readonly platform: NodeJS.Platform;
  readonly windowsAcl: (request: SignupAclRequest) => void;
};

const DEFAULT_RUNTIME: SignupFileRuntime = {
  platform: process.platform,
  windowsAcl: runSignupWindowsAcl,
};

function requirePrivateMode(stat: Stats, directory: boolean, runtime: SignupFileRuntime): void {
  if (runtime.platform === "win32") return;
  if (
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    throw new Error(
      directory
        ? "Signup credentials directory must be private and owned by the current user"
        : "Signup credential files must be accessible only to their owner",
    );
  }
}

function directoryMetadata(path: string, runtime: SignupFileRuntime): void {
  const stat: Stats = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Signup credentials directory must be private and must not be a symbolic link");
  }
  requirePrivateMode(stat, true, runtime);
}

function fileMetadata(path: string, runtime: SignupFileRuntime): Stats {
  const stat: Stats = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > MAX_CREDENTIAL_BYTES
  ) {
    throw new Error("Signup credentials must be bounded regular private files without links");
  }
  requirePrivateMode(stat, false, runtime);
  return stat;
}

function requireCredentialPath(path: string, runtime: SignupFileRuntime): void {
  if (!isAbsolute(path) || !CREDENTIAL_NAMES.has(basename(path))) {
    throw new Error(
      "Signup credentials must use a recognized file in an absolute private directory",
    );
  }
  directoryMetadata(dirname(path), runtime);
  if (runtime.platform === "win32") {
    runtime.windowsAcl({ directory: true, operation: "verify", path: dirname(path) });
  }
}

export function prepareSignupDirectory(
  path: string,
  runtime: SignupFileRuntime = DEFAULT_RUNTIME,
): void {
  if (!isAbsolute(path) || dirname(path) === path) {
    throw new Error(
      "Signup credentials directory must be absolute and must use a dedicated non-root directory",
    );
  }
  mkdirSync(path, { mode: 0o700, recursive: true });
  directoryMetadata(path, runtime);
  const directory: ReturnType<typeof opendirSync> = opendirSync(path);
  try {
    let entry: ReturnType<typeof directory.readSync> = directory.readSync();
    while (entry !== null) {
      if (!CREDENTIAL_NAMES.has(entry.name)) {
        throw new Error(
          "Signup requires a dedicated directory containing only its credential files",
        );
      }
      fileMetadata(join(path, entry.name), runtime);
      entry = directory.readSync();
    }
  } finally {
    directory.closeSync();
  }
  if (runtime.platform === "win32") {
    runtime.windowsAcl({ directory: true, operation: "protect", path });
  }
}

export function readSignupPrivateFile(
  path: string,
  runtime: SignupFileRuntime = DEFAULT_RUNTIME,
): string {
  requireCredentialPath(path, runtime);
  const initial: Stats = fileMetadata(path, runtime);
  if (runtime.platform === "win32")
    runtime.windowsAcl({ directory: false, operation: "protect", path });
  const descriptor: number = openSync(
    path,
    constants.O_RDONLY | (runtime.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened: Stats = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.nlink !== 1 ||
      opened.size > MAX_CREDENTIAL_BYTES
    ) {
      throw new Error("Signup credential file changed before it could be read safely");
    }
    const buffer: Buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const read: number = readSync(descriptor, buffer, 0, buffer.byteLength, null);
    if (read > MAX_CREDENTIAL_BYTES) throw new Error("Signup credential file is too large");
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function saveSignupPrivateFile(
  path: string,
  value: unknown,
  runtime: SignupFileRuntime = DEFAULT_RUNTIME,
): void {
  const content: string = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CREDENTIAL_BYTES)
    throw new Error("Signup credential file is too large");
  requireCredentialPath(path, runtime);
  if (existsSync(path)) throw new Error("Signup credential checkpoint already exists");
  const descriptor: number = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let complete: boolean = false;
  try {
    fileMetadata(path, runtime);
    // The protected directory already prevents inherited access; establish the exact file ACL
    // while the file is still empty, before writing any registration secret or credential.
    if (runtime.platform === "win32")
      runtime.windowsAcl({ directory: false, operation: "protect", path });
    const current: Stats = fileMetadata(path, runtime);
    const opened: Stats = fstatSync(descriptor);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("Signup credential file changed before it could be written safely");
    }
    writeFileSync(descriptor, content, "utf8");
    complete = true;
    fsyncSync(descriptor);
  } catch (error: unknown) {
    if (!complete) unlinkSync(path);
    throw error;
  } finally {
    closeSync(descriptor);
  }
}
