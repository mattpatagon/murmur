import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  assertNoE2eePlaintextLeak,
  type LeakEncoding,
  type LeakFinding,
  type LeakScanResult,
  scanE2eeCaptures,
} from "../scripts/e2ee-leak-detector.js";

const SENTINEL: string = "murmur plaintext leak sentinel 🔐 2026-08-10";
const ENCODINGS: readonly LeakEncoding[] = [
  "base64",
  "base64url",
  "hex",
  "json",
  "percent",
  "raw_utf8",
  "utf16be",
  "utf16le",
];

function encodings(value: string): Readonly<Record<LeakEncoding, Uint8Array | string>> {
  const raw: Buffer = Buffer.from(value, "utf8");
  const little: Buffer = Buffer.from(value, "utf16le");
  const big: Buffer = Buffer.alloc(little.byteLength);
  for (let index: number = 0; index < little.byteLength; index += 2) {
    const low: number | undefined = little[index];
    const high: number | undefined = little[index + 1];
    if (low === undefined || high === undefined) throw new Error("UTF-16 fixture is incomplete");
    big[index] = high;
    big[index + 1] = low;
  }
  return {
    base64: raw.toString("base64"),
    base64url: raw.toString("base64url"),
    hex: raw.toString("hex"),
    json: JSON.stringify(value).slice(1, -1),
    percent: encodeURIComponent(value),
    raw_utf8: raw,
    utf16be: big,
    utf16le: little,
  };
}

test("detects every supported reversible plaintext encoding with positive controls", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-leak-positive-"));
  try {
    const fixtures: Readonly<Record<LeakEncoding, Uint8Array | string>> = encodings(SENTINEL);
    Object.entries(fixtures).forEach(([name, value]: [string, Uint8Array | string]): void => {
      writeFileSync(join(directory, `${name}.capture`), value);
    });
    const result: LeakScanResult = scanE2eeCaptures(directory, [SENTINEL]);
    const found: Set<LeakEncoding> = new Set<LeakEncoding>(
      result.findings.map((finding: LeakFinding): LeakEncoding => finding.encoding),
    );
    expect(found).toEqual(new Set<LeakEncoding>(ENCODINGS));
    expect((): LeakScanResult => assertNoE2eePlaintextLeak(directory, [SENTINEL])).toThrow(
      "reversible sentinel encoding",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("accepts clean bounded binary captures and rejects symlink traversal", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-leak-clean-"));
  try {
    writeFileSync(join(directory, "ciphertext.capture"), Buffer.alloc(4_096, 173));
    const result: LeakScanResult = assertNoE2eePlaintextLeak(directory, [SENTINEL]);
    expect(result).toEqual({ bytes_scanned: 4_096, files_scanned: 1, findings: [] });
    symlinkSync(join(directory, "ciphertext.capture"), join(directory, "linked.capture"));
    expect((): LeakScanResult => scanE2eeCaptures(directory, [SENTINEL])).toThrow("symbolic links");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("decodes bounded gzip captures before declaring plaintext absent", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-leak-gzip-"));
  try {
    const capture: Buffer = gzipSync(Buffer.from(`prefix ${SENTINEL} suffix`, "utf8"));
    expect(capture.includes(Buffer.from(SENTINEL, "utf8"))).toBe(false);
    writeFileSync(join(directory, "http-body.capture.gz"), capture);
    const result: LeakScanResult = scanE2eeCaptures(directory, [SENTINEL]);
    expect(result.findings).toContainEqual({
      capture: "http-body.capture.gz",
      container: "gzip",
      encoding: "raw_utf8",
      sentinel_index: 0,
    });
    expect((): LeakScanResult => assertNoE2eePlaintextLeak(directory, [SENTINEL])).toThrow(
      "reversible sentinel encoding",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fails closed on gzip bombs or malformed gzip captures", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-leak-bad-gzip-"));
  try {
    writeFileSync(join(directory, "broken.capture.gz"), Uint8Array.from([0x1f, 0x8b, 0, 0]));
    expect((): LeakScanResult => scanE2eeCaptures(directory, [SENTINEL])).toThrow(
      "invalid or oversized gzip payload",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects sentinels too short to avoid noisy proof results", (): void => {
  const directory: string = mkdtempSync(join(tmpdir(), "murmur-e2ee-leak-short-"));
  try {
    writeFileSync(join(directory, "empty.capture"), "");
    expect((): LeakScanResult => scanE2eeCaptures(directory, ["too short"])).toThrow(
      "between 16 and 4096",
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
