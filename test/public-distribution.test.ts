import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  distributionDownloadPath,
  distributionPackageVersion,
  type DistributionManifest,
} from "../src/domain/distribution-contracts.js";
import type { TimeSource } from "../src/http/http-capacity.js";
import {
  createPublicDownloadHandler,
  isPublicDistributionPath,
  loadPublicDistribution,
  type PublicDistribution,
  type PublicDownloadHandler,
} from "../src/http/public-distribution.js";
import { type MurmurHttpServer, startHttpServer } from "../src/http-server.js";
import { testEnvironment } from "./support/http-mcp-harness.js";

const REVISION: string = "1111111111111111111111111111111111111111";

function fixture(): PublicDistribution {
  const bytes: Uint8Array = new Uint8Array(200_000).fill(123);
  return {
    bytes,
    manifest: {
      bytes: bytes.byteLength,
      revision: REVISION,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: "1.2.3.4",
    },
  };
}

function request(path: string = "/downloads/murmur.tgz", method: string = "GET"): Request {
  return new Request(`https://api.usemurmur.dev${path}`, { method });
}

test("public download verifies release, digest, size and safe package identity", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-download-"));
  const distribution: PublicDistribution = fixture();
  const manifest: DistributionManifest = distribution.manifest;
  const release: { version: string; revision: string } = {
    version: manifest.version,
    revision: manifest.revision,
  };
  try {
    writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
    writeFileSync(join(directory, "murmur.tgz"), distribution.bytes);
    expect(loadPublicDistribution(directory, release)).toEqual(distribution);
    expect(loadPublicDistribution(undefined, release)).toBeNull();
    expect(loadPublicDistribution(directory, null)).toBeNull();
    expect((): PublicDistribution | null => loadPublicDistribution("relative", release)).toThrow(
      "absolute",
    );
    expect((): PublicDistribution | null =>
      loadPublicDistribution(directory, { ...release, version: "1.2.3.5" }),
    ).toThrow("does not match");
    writeFileSync(join(directory, "murmur.tgz"), "tampered");
    expect((): PublicDistribution | null => loadPublicDistribution(directory, release)).toThrow(
      "does not match",
    );
    writeFileSync(join(directory, "release.json"), "x".repeat(1025));
    expect((): PublicDistribution | null => loadPublicDistribution(directory, release)).toThrow(
      "invalid",
    );
    expect(distributionPackageVersion("1.2.3.4")).toBe("1.2.3-build.4");
    expect((): string => distributionDownloadPath("1.2.3.4", "../private")).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("public package routes are unauthenticated, fixed, method-restricted and cache-aware", async (): Promise<void> => {
  const distribution: PublicDistribution = fixture();
  const handler: PublicDownloadHandler = createPublicDownloadHandler(distribution);
  const canonical: Response = handler(request());
  expect(canonical.status).toBe(200);
  expect(canonical.headers.get("cache-control")).toBe("no-store");
  expect(canonical.headers.get("etag")).toBe(`"${distribution.manifest.sha256}"`);
  expect([...new Uint8Array(await canonical.arrayBuffer())]).toEqual([...distribution.bytes]);
  const pinned: Response = handler(request(distributionDownloadPath("1.2.3.4", REVISION), "HEAD"));
  expect(pinned.headers.get("cache-control")).toContain("immutable");
  expect(pinned.headers.get("content-length")).toBe("200000");
  expect(pinned.body).toBeNull();
  expect(handler(request("/downloads/secret.tgz")).status).toBe(404);
  expect(handler(request("/downloads/murmur.tgz", "POST")).status).toBe(405);
  expect(createPublicDownloadHandler(null)(request()).status).toBe(503);
  expect(isPublicDistributionPath("/install")).toBe(true);
  expect(isPublicDistributionPath("/downloads/anything")).toBe(true);
  expect(isPublicDistributionPath("/mcp")).toBe(false);
  const installGuide: string = await handler(request("/install")).text();
  expect(installGuide).toContain("get_setup_guide");
  expect(installGuide).toContain("fx mcp add --transport http murmur");
  expect(handler(request("/install", "HEAD")).body).toBeNull();
});

test("public download caps retained streams and releases them on cancellation and deadline", async (): Promise<void> => {
  const callbacks: Set<() => void> = new Set<() => void>();
  const time: TimeSource = {
    now: (): number => 0,
    schedule: (milliseconds: number, callback: () => void): (() => void) => {
      expect(milliseconds).toBe(30_000);
      callbacks.add(callback);
      return (): void => {
        callbacks.delete(callback);
      };
    },
  };
  const handler: PublicDownloadHandler = createPublicDownloadHandler(fixture(), time);
  const pending: Response[] = Array.from({ length: 8 }, (): Response => handler(request()));
  expect(handler(request()).status).toBe(429);
  const first: Response | undefined = pending.shift();
  if (first === undefined || first.body === null) throw new Error("Missing pending download");
  await first.body.cancel();
  pending.push(handler(request()));
  expect(callbacks.size).toBe(8);
  for (const callback of [...callbacks]) callback();
  for (const response of pending) {
    const read: () => Promise<ArrayBuffer> = async (): Promise<ArrayBuffer> =>
      await response.arrayBuffer();
    await expect(read()).rejects.toThrow("deadline exceeded");
  }
  expect(callbacks.size).toBe(0);
  expect((await handler(request()).arrayBuffer()).byteLength).toBe(200_000);
});

test("public download request rates are bounded and recover at the next fixed window", async (): Promise<void> => {
  let now: number = 0;
  const time: TimeSource = {
    now: (): number => now,
    schedule:
      (_milliseconds: number, _callback: () => void): (() => void) =>
      (): void => {},
  };
  const handler: PublicDownloadHandler = createPublicDownloadHandler(fixture(), time);
  for (let index: number = 0; index < 120; index += 1) {
    expect((await handler(request()).arrayBuffer()).byteLength).toBe(200_000);
  }
  expect(handler(request()).status).toBe(429);
  now = 60_000;
  expect((await handler(request()).arrayBuffer()).byteLength).toBe(200_000);
});

test("the actual hosted router serves its validated public artifact without a credential", async (): Promise<void> => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-download-http-"));
  const distribution: PublicDistribution = fixture();
  const manifest: DistributionManifest = {
    ...distribution.manifest,
    version: packageMetadata.version,
  };
  writeFileSync(join(directory, "release.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "murmur.tgz"), distribution.bytes);
  let server: MurmurHttpServer | null = null;
  try {
    server = await startHttpServer({
      ...testEnvironment(join(directory, "messages.db")),
      MURMUR_DISTRIBUTION_DIRECTORY: directory,
      MURMUR_RELEASE_REVISION: REVISION,
    });
    const response: Response = await fetch(new URL("/downloads/murmur.tgz", server.mcpUrl));
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(distribution.bytes.byteLength);
    const instructions: Response = await fetch(new URL("/install", server.mcpUrl));
    expect(await instructions.text()).toContain("get_setup_guide");
  } finally {
    if (server !== null) await server.stop();
    rmSync(directory, { force: true, recursive: true });
  }
});
