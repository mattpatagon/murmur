#!/usr/bin/env bun

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import {
  ProductionStreamLogFailure,
  requireStreamLog,
  STREAM_LOG_CONTEXT_FILE,
  STREAM_LOG_MAX_BYTES,
  STREAM_LOG_RESULT_FILE,
  type StreamLogConfiguration,
  type StreamLogContext,
  streamLogJson,
  validateStreamLogConfiguration,
} from "./lib/production-stream-log-contracts.js";
import { STREAM_LOG_RUNTIME } from "./lib/production-stream-log-process.js";
import {
  preflightProductionStreamLogs,
  verifyProductionStreamLogs,
} from "./lib/production-stream-log-verifier.js";

async function boundedText(path: string): Promise<string> {
  const file: FileHandle = await open(path, "r");
  try {
    const buffer: Buffer = Buffer.alloc(STREAM_LOG_MAX_BYTES + 1);
    let length: number = 0;
    while (length < buffer.length) {
      const read: { readonly bytesRead: number } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    requireStreamLog(length <= STREAM_LOG_MAX_BYTES);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

async function main(): Promise<void> {
  const mode: string | undefined = process.argv[2];
  requireStreamLog(process.argv.length === 3 && (mode === "preflight" || mode === "verify"));
  const directory: string | undefined = process.env["RUNNER_TEMP"];
  requireStreamLog(directory !== undefined && isAbsolute(directory));
  const config: StreamLogConfiguration = validateStreamLogConfiguration({
    project: process.env["PROJECT_ID"],
    region: process.env["REGION"],
    service: process.env["SERVICE"],
    repository: process.env["ARTIFACT_REPOSITORY"],
    expectedVersion: process.env["MURMUR_LIVE_EXPECTED_VERSION"],
    expectedSha: process.env["EXPECTED_GITHUB_SHA"],
    origin: process.env["PRODUCTION_URL"],
  });
  const contextPath: string = join(directory, STREAM_LOG_CONTEXT_FILE);
  if (mode === "preflight") {
    const context: StreamLogContext = await preflightProductionStreamLogs(
      config,
      STREAM_LOG_RUNTIME,
    );
    const file: FileHandle = await open(contextPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(context)}\n`, "utf8");
    } finally {
      await file.close();
    }
    process.stdout.write(
      `${JSON.stringify({ event: "production-stream-log-access-verified", revision: context.revision, expectedSha: context.expectedSha, version: context.version })}\n`,
    );
  } else {
    const contextValue: unknown = streamLogJson(await boundedText(contextPath));
    const result: string = await boundedText(join(directory, STREAM_LOG_RESULT_FILE));
    const verified: Awaited<ReturnType<typeof verifyProductionStreamLogs>> =
      await verifyProductionStreamLogs(config, contextValue, result, STREAM_LOG_RUNTIME);
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  }
}

if (import.meta.main) {
  main().catch((_error: unknown): void => {
    process.stderr.write(`${new ProductionStreamLogFailure().message}\n`);
    process.exitCode = 1;
  });
}
