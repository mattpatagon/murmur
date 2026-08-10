import { type Dirent, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const MAX_CAPTURE_FILES: number = 1_000;
const MAX_CAPTURE_FILE_BYTES: number = 16 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_BYTES: number = 64 * 1024 * 1024;
const MIN_SENTINEL_BYTES: number = 16;
const MAX_SENTINEL_BYTES: number = 4_096;

export type LeakEncoding =
  | "base64"
  | "base64url"
  | "hex"
  | "json"
  | "percent"
  | "raw_utf8"
  | "utf16be"
  | "utf16le";

export type LeakFinding = {
  readonly capture: string;
  readonly encoding: LeakEncoding;
  readonly sentinel_index: number;
};

export type LeakScanResult = {
  readonly bytes_scanned: number;
  readonly files_scanned: number;
  readonly findings: readonly LeakFinding[];
};

type Pattern = {
  readonly bytes: Uint8Array;
  readonly encoding: LeakEncoding;
};

function utf16BigEndian(value: string): Uint8Array {
  const little: Buffer = Buffer.from(value, "utf16le");
  const big: Uint8Array = new Uint8Array(little.byteLength);
  for (let index: number = 0; index < little.byteLength; index += 2) {
    const low: number | undefined = little[index];
    const high: number | undefined = little[index + 1];
    if (low === undefined || high === undefined) throw new Error("UTF-16 encoding is incomplete");
    big[index] = high;
    big[index + 1] = low;
  }
  return big;
}

function patternsFor(sentinel: string): readonly Pattern[] {
  const raw: Buffer = Buffer.from(sentinel, "utf8");
  if (raw.byteLength < MIN_SENTINEL_BYTES || raw.byteLength > MAX_SENTINEL_BYTES) {
    throw new Error(
      `E2E leak sentinel must contain between ${MIN_SENTINEL_BYTES} and ${MAX_SENTINEL_BYTES} UTF-8 bytes`,
    );
  }
  const json: string = JSON.stringify(sentinel).slice(1, -1);
  return [
    { bytes: raw, encoding: "raw_utf8" },
    { bytes: Buffer.from(raw.toString("base64"), "ascii"), encoding: "base64" },
    { bytes: Buffer.from(raw.toString("base64url"), "ascii"), encoding: "base64url" },
    { bytes: Buffer.from(raw.toString("hex"), "ascii"), encoding: "hex" },
    { bytes: Buffer.from(json, "utf8"), encoding: "json" },
    { bytes: Buffer.from(encodeURIComponent(sentinel), "ascii"), encoding: "percent" },
    { bytes: Buffer.from(sentinel, "utf16le"), encoding: "utf16le" },
    { bytes: utf16BigEndian(sentinel), encoding: "utf16be" },
  ];
}

function captureFiles(path: string): readonly string[] {
  const root: string = resolve(path);
  const pending: string[] = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current: string | undefined = pending.pop();
    if (current === undefined) break;
    const metadata: ReturnType<typeof lstatSync> = lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("E2E leak capture paths may not contain symbolic links");
    }
    if (metadata.isFile()) {
      files.push(current);
      if (files.length > MAX_CAPTURE_FILES) throw new Error("E2E leak capture file limit exceeded");
      continue;
    }
    if (!metadata.isDirectory()) throw new Error("E2E leak capture path is unsupported");
    const entries: readonly Dirent[] = readdirSync(current, { withFileTypes: true }).sort(
      (left: Dirent, right: Dirent): number => left.name.localeCompare(right.name),
    );
    for (let index: number = entries.length - 1; index >= 0; index -= 1) {
      const entry: Dirent | undefined = entries[index];
      if (entry === undefined) continue;
      pending.push(join(current, entry.name));
    }
  }
  return files.sort((left: string, right: string): number => left.localeCompare(right));
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle);
}

export function scanE2eeCaptures(
  capturePath: string,
  sentinels: readonly string[],
): LeakScanResult {
  if (sentinels.length < 1 || sentinels.length > 100) {
    throw new Error("E2E leak scan requires between 1 and 100 sentinels");
  }
  const patterns: readonly (readonly Pattern[])[] = sentinels.map(patternsFor);
  const findings: LeakFinding[] = [];
  let bytesScanned: number = 0;
  let filesScanned: number = 0;
  for (const file of captureFiles(capturePath)) {
    const metadata: ReturnType<typeof lstatSync> = lstatSync(file);
    if (metadata.size > MAX_CAPTURE_FILE_BYTES) {
      throw new Error("E2E leak capture file size limit exceeded");
    }
    bytesScanned += metadata.size;
    if (bytesScanned > MAX_CAPTURE_TOTAL_BYTES) {
      throw new Error("E2E leak capture total size limit exceeded");
    }
    const bytes: Buffer = readFileSync(file);
    filesScanned += 1;
    patterns.forEach((sentinelPatterns: readonly Pattern[], sentinelIndex: number): void => {
      sentinelPatterns.forEach((pattern: Pattern): void => {
        if (contains(bytes, pattern.bytes)) {
          findings.push({
            capture: basename(file),
            encoding: pattern.encoding,
            sentinel_index: sentinelIndex,
          });
        }
      });
    });
  }
  return { bytes_scanned: bytesScanned, files_scanned: filesScanned, findings };
}

export function assertNoE2eePlaintextLeak(
  capturePath: string,
  sentinels: readonly string[],
): LeakScanResult {
  const result: LeakScanResult = scanE2eeCaptures(capturePath, sentinels);
  if (result.findings.length !== 0) {
    throw new Error("E2E plaintext leak detector found a reversible sentinel encoding");
  }
  return result;
}
