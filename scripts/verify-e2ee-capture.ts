import { readFileSync, statSync } from "node:fs";
import process from "node:process";

import {
  type IndependentVerification,
  verifyCapturedEnvelope,
} from "./e2ee-independent-verifier.js";

const MAX_CAPTURE_BYTES: number = 1024 * 1024;

function usage(): never {
  throw new Error("Usage: bun run scripts/verify-e2ee-capture.ts CAPTURE.json VERIFICATION_TIME");
}

function readCapture(path: string): unknown {
  const size: number = statSync(path).size;
  if (size > MAX_CAPTURE_BYTES) throw new Error("Encrypted capture exceeds the verification limit");
  const bytes: Uint8Array = readFileSync(path);
  if (bytes.byteLength > MAX_CAPTURE_BYTES) {
    throw new Error("Encrypted capture exceeds the verification limit");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_error: unknown) {
    throw new Error("Encrypted capture JSON is invalid");
  }
}

async function main(): Promise<void> {
  const path: string | undefined = process.argv[2];
  const verificationTime: string | undefined = process.argv[3];
  if (path === undefined || verificationTime === undefined || process.argv.length !== 4) usage();
  const now: Date = new Date(verificationTime);
  if (!Number.isFinite(now.getTime()))
    throw new Error("Verification time must be an ISO timestamp");
  const result: IndependentVerification = await verifyCapturedEnvelope(readCapture(path), now);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
