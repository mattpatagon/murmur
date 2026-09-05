import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DistributionManifestSchema,
  distributionDownloadPath,
  MAX_DISTRIBUTION_BYTES,
  PUBLIC_DOWNLOAD_PATH,
  type DistributionManifest,
} from "../domain/distribution-contracts.js";
import type { MurmurReleaseMetadata } from "../domain/upgrade-contracts.js";
import { SYSTEM_TIME_SOURCE, type TimeSource } from "./http-capacity.js";
import { jsonResponse } from "./http-request.js";

export type PublicDistribution = {
  readonly bytes: Uint8Array;
  readonly manifest: DistributionManifest;
};

export type PublicDownloadHandler = (request: Request) => Response;

export function configuredPublicDownloads(
  environment: NodeJS.ProcessEnv,
  release: MurmurReleaseMetadata | null,
  time: TimeSource,
): PublicDownloadHandler {
  return createPublicDownloadHandler(
    loadPublicDistribution(environment["MURMUR_DISTRIBUTION_DIRECTORY"], release),
    time,
  );
}

function boundedFile(path: string, maximum: number): Uint8Array {
  const metadata: ReturnType<typeof lstatSync> = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum) {
    throw new Error("Public distribution file is invalid");
  }
  const bytes: Uint8Array = readFileSync(path);
  if (bytes.byteLength > maximum) throw new Error("Public distribution file exceeds its limit");
  return bytes;
}

export function loadPublicDistribution(
  directory: string | undefined,
  release: MurmurReleaseMetadata | null,
): PublicDistribution | null {
  if (directory === undefined) return null;
  if (directory.length > 4096 || !isAbsolute(directory)) {
    throw new Error("Public distribution directory must be an absolute path");
  }
  if (release === null) return null;
  const manifestBytes: Uint8Array = boundedFile(join(directory, "release.json"), 1024);
  const raw: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestBytes));
  const manifest: DistributionManifest = DistributionManifestSchema.parse(raw);
  const bytes: Uint8Array = boundedFile(join(directory, "murmur.tgz"), MAX_DISTRIBUTION_BYTES);
  if (
    manifest.version !== release.version ||
    manifest.revision !== release.revision ||
    manifest.bytes !== bytes.byteLength ||
    manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")
  ) {
    throw new Error("Public distribution does not match the running release");
  }
  return { bytes, manifest };
}

export function isPublicDistributionPath(pathname: string): boolean {
  return pathname === "/install" || pathname.startsWith("/downloads/");
}

function methodAllowed(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

export function createPublicDownloadHandler(
  distribution: PublicDistribution | null,
  time: TimeSource = SYSTEM_TIME_SOURCE,
): PublicDownloadHandler {
  let active: number = 0;
  let windowStarted: number = time.now();
  let requests: number = 0;
  return (request: Request): Response => {
    const path: string = new URL(request.url).pathname;
    if (!methodAllowed(request)) {
      return new Response(null, { headers: { allow: "GET, HEAD" }, status: 405 });
    }
    if (path === "/install") {
      return new Response(
        request.method === "HEAD"
          ? null
          : [
              "Murmur setup (no account or token needed to begin)",
              "",
              "Codex:",
              "codex mcp add murmur --url https://api.usemurmur.dev/setup/mcp",
              "Claude Code:",
              "claude mcp add --transport http --scope user murmur https://api.usemurmur.dev/setup/mcp",
              "Restart the agent and ask it to call get_setup_guide.",
              "",
              "The guide walks through organization signup, token setup, hooks, and encryption.",
              "For hooks and encryption, install Bun 1.3.11 or newer and the public package:",
              "bun install --global https://api.usemurmur.dev/downloads/murmur.tgz",
              "",
              "murmur signup --slug YOUR_ORGANIZATION --name 'Your Organization'",
              "With your credential in MURMUR_API_TOKEN, run murmur setup --user and restart your agent host.",
              "The source repository is private; no GitHub account or repository access is required.",
              "",
            ].join("\n"),
        {
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        },
      );
    }
    if (distribution === null) return jsonResponse(503, { error: "Public download unavailable" });
    const exactPath: string = distributionDownloadPath(
      distribution.manifest.version,
      distribution.manifest.revision,
    );
    if (path !== PUBLIC_DOWNLOAD_PATH && path !== exactPath) {
      return jsonResponse(404, { error: "Not found" });
    }
    const headers: Headers = new Headers({
      "cache-control": path === exactPath ? "public, max-age=31536000, immutable" : "no-store",
      "content-disposition": 'attachment; filename="murmur.tgz"',
      "content-length": String(distribution.bytes.byteLength),
      "content-type": "application/gzip",
      etag: `"${distribution.manifest.sha256}"`,
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    if (time.now() - windowStarted >= 60_000) {
      requests = 0;
      windowStarted = time.now();
    }
    if (requests >= 120 || active >= 8) {
      return new Response(null, { headers: { "retry-after": "60" }, status: 429 });
    }
    requests += 1;
    active += 1;
    let finished: boolean = false;
    let cancelDeadline: (() => void) | null = null;
    const finish: () => void = (): void => {
      if (finished) return;
      finished = true;
      active -= 1;
      if (cancelDeadline !== null) cancelDeadline();
    };
    let offset: number = 0;
    const stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      cancel: finish,
      pull: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
        if (offset >= distribution.bytes.byteLength) {
          controller.close();
          finish();
          return;
        }
        const end: number = Math.min(offset + 64 * 1024, distribution.bytes.byteLength);
        controller.enqueue(distribution.bytes.slice(offset, end));
        offset = end;
      },
      start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
        cancelDeadline = time.schedule(30_000, (): void => {
          controller.error(new Error("Public download deadline exceeded"));
          finish();
        });
      },
    });
    return new Response(stream, { headers });
  };
}
