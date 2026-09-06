import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  type DistributionManifest,
  DistributionManifestSchema,
  MAX_DISTRIBUTION_BYTES,
} from "../src/domain/distribution-contracts.js";
import { MurmurRevisionSchema, MurmurVersionSchema } from "../src/domain/upgrade-contracts.js";

type ImagePackage = {
  readonly name: "murmur-agent-chat-mcp";
  readonly version: string;
};

type VerificationEnvironment = {
  readonly revision: string;
};

type VerificationPhase = "configuration" | "sdk-declarations" | "sdk-runtime" | "distribution";

const PackageSchema: z.ZodType<ImagePackage> = z.object({
  name: z.literal("murmur-agent-chat-mcp"),
  version: MurmurVersionSchema,
});
const EnvironmentSchema: z.ZodType<VerificationEnvironment> = z.strictObject({
  revision: MurmurRevisionSchema,
});
const MAXIMUM_PACKAGE_BYTES: number = 64 * 1024;
const MAXIMUM_DECLARATION_BYTES: number = 128 * 1024;
const MAXIMUM_MANIFEST_BYTES: number = 4096;

function readBoundedFile(path: string, maximumBytes: number): Uint8Array {
  // Nonblocking open lets the regular-file check reject a FIFO without waiting for a writer.
  const descriptor: number = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const information: Stats = fstatSync(descriptor);
    if (
      !information.isFile() ||
      !Number.isSafeInteger(information.size) ||
      information.size <= 0 ||
      information.size > maximumBytes
    ) {
      throw new Error("Image artifact exceeds its validated bounds");
    }
    const content: Uint8Array = new Uint8Array(information.size + 1);
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
    if (offset !== information.size) throw new Error("Image artifact changed during verification");
    return content.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedText(path: string, maximumBytes: number): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(path, maximumBytes));
}

function readBoundedJson(path: string, maximumBytes: number): unknown {
  return JSON.parse(readBoundedText(path, maximumBytes));
}

function verifySdkDeclarations(root: string): void {
  for (const format of ["esm", "cjs"]) {
    const path: string = join(
      root,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      format,
      "shared",
      "transport.d.ts",
    );
    const declaration: string = readBoundedText(path, MAXIMUM_DECLARATION_BYTES);
    const patched: RegExpMatchArray | null = declaration.match(
      /^\s*sessionId\?:\s*string\s*\|\s*undefined;\s*$/gmu,
    );
    if (
      patched === null ||
      patched.length !== 1 ||
      /^\s*sessionId\?:\s*string;\s*$/mu.test(declaration)
    ) {
      throw new Error("The reviewed SDK declaration patch is missing");
    }
  }
}

async function verifySdkRuntime(): Promise<void> {
  const sdk: unknown = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  if (
    typeof sdk !== "object" ||
    sdk === null ||
    !("StreamableHTTPClientTransport" in sdk) ||
    typeof sdk.StreamableHTTPClientTransport !== "function"
  ) {
    throw new Error("The SDK runtime export is unavailable");
  }
}

async function main(): Promise<void> {
  let phase: VerificationPhase = "configuration";
  try {
    const root: string = fileURLToPath(new URL("../", import.meta.url));
    const environment: VerificationEnvironment = EnvironmentSchema.parse({
      revision: process.env["MURMUR_IMAGE_EXPECTED_REVISION"],
    });
    const metadata: ImagePackage = PackageSchema.parse(
      readBoundedJson(join(root, "package.json"), MAXIMUM_PACKAGE_BYTES),
    );
    phase = "sdk-declarations";
    verifySdkDeclarations(root);
    phase = "sdk-runtime";
    await verifySdkRuntime();
    phase = "distribution";
    const manifest: DistributionManifest = DistributionManifestSchema.parse(
      readBoundedJson(join(root, "dist", "public", "release.json"), MAXIMUM_MANIFEST_BYTES),
    );
    const archive: Uint8Array = readBoundedFile(
      join(root, "dist", "public", "murmur.tgz"),
      MAX_DISTRIBUTION_BYTES,
    );
    if (
      manifest.version !== metadata.version ||
      manifest.revision !== environment.revision ||
      manifest.bytes !== archive.byteLength ||
      manifest.sha256 !== createHash("sha256").update(archive).digest("hex")
    ) {
      throw new Error("The image distribution metadata does not match its artifact");
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "production-image-verified",
        version: metadata.version,
        revision: manifest.revision,
        patchedEsm: true,
        patchedCjs: true,
        sdkRuntimeImport: true,
        distributionIntegrity: true,
      })}\n`,
    );
  } catch {
    process.stderr.write(
      `${JSON.stringify({ event: "production-image-verification-failed", phase })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
